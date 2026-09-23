/**
 * QueryAnalytics - Advanced, allowlisted analytics builder for Mongoose (v8/v9)
 *
 * Sits alongside QueryFind (Model.find()) and QueryAggregate (generic pipeline
 * builder). QueryAnalytics is purpose-built for dashboards/reporting.
 * Assumes a modern MongoDB server (7.0+): uses $setWindowFields, $rank,
 * $shift, $stdDevPop and $percentile natively — no manual fallbacks.
 *
 * Feature map:
 *  - timeSeries()          bucketed metrics over time, gap-filled
 *  - cumulativeSeries()    time series + native running-total column
 *  - compare()             period-over-period, % change
 *  - breakdown()           top-N by a dimension
 *  - rankedBreakdown()     breakdown + dense rank per row (native $setWindowFields)
 *  - multiBreakdown()      pivot by two dimensions
 *  - funnel()              sequential step conversion
 *  - cohortRetention()     cohort-by-cohort retention matrix
 *  - sessionize()          gap-based event sessionization ($setWindowFields + $shift)
 *  - percentiles()         p50/p90/p99/... via native $percentile
 *  - stdDevOutliers()      flag documents beyond N std deviations
 *  - metrics()             one-shot multi-metric summary (single round trip)
 *  - movingAverage/trend   pure-JS post-processing on an existing series
 *  - forecast()            simple linear-regression projection (pure JS)
 *  - heatmap()             weekday x hour-of-day matrix
 *  - watch()               live change-stream subscription for dashboards
 *  - toCSV/toNDJSON        export helpers
 *  - dashboard()           run several analytics calls in parallel, keyed
 *  - built-in TTL cache
 *
 * Usage:
 *   const qa = new QueryAnalytics(OrderModel, { timezone: 'Asia/Dhaka' })
 *     .match({ branchId, status: { $ne: 'CANCELLED' } })
 *     .dateRange('createdAt', { from: '2026-08-01', to: '2026-08-31' });
 *
 *   const series = await qa.timeSeries({
 *     dateField: 'createdAt', interval: 'day',
 *     metrics: [{ name: 'revenue', op: 'sum', field: 'total' }, { name: 'orders', op: 'count' }],
 *   });
 */

import {
  addDays,
  addHours,
  addMonths,
  addWeeks,
  format,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { Model, PipelineStage } from 'mongoose';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEZONE = 'Asia/Dhaka';
const DEFAULT_MAX_TIME_MS = 8_000;
const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BANNED_STAGE_OPERATORS = new Set(['$out', '$merge']);

/**
 * Mongoose's PipelineStage union type is a strict discriminated union with
 * no index signature per member — fine for a handful of well-typed stages,
 * but it fights the compiler as soon as $setWindowFields/$percentile/$shift/
 * $denseRank/$stdDevPop (or any $match on a computed field) get mixed in.
 * Every pipeline below is built as Stage[] (a loose, permissive — but not
 * `any` — shape) and narrowed to PipelineStage[] exactly once, at the two
 * points that actually call into Mongoose (aggregate() and watch()) — see
 * `run()` and `watch()`. Record<string, unknown> and PipelineStage don't
 * overlap enough for TS to allow a direct assertion, so that one boundary
 * conversion goes through `unknown` — an explicit, narrow escape hatch
 * rather than a blanket `any`.
 */
type Stage = Record<string, unknown>;

export type Interval = 'hour' | 'day' | 'week' | 'month';
export type ComparePreset =
  | 'today'
  | 'thisWeek'
  | 'thisMonth'
  | 'last7Days'
  | 'last30Days';

export interface StatSpec {
  name: string;
  op: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinctCount';
  /** Required for every op except 'count'. */
  field?: string;
}

export interface QueryAnalyticsOptions {
  timezone?: string;
  maxTimeMS?: number;
  allowDiskUse?: boolean;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** TTL in ms for the built-in in-memory cache. 0 disables caching (default). */
  cacheTTLMs?: number;
}

export interface TimeSeriesPoint {
  bucket: string; // ISO string, local-boundary-aligned
  [metric: string]: number | string;
}

export interface CompareResult {
  current: Record<string, number>;
  previous: Record<string, number>;
  change: Record<string, number>; // absolute delta
  changePct: Record<string, number | null>; // null when previous was 0
}

export interface BreakdownRow {
  key: unknown;
  [metric: string]: unknown;
}

export interface RankedBreakdownRow extends BreakdownRow {
  rank: number;
}

export interface FunnelStep {
  name: string;
  match: Record<string, unknown>;
}

export interface FunnelResult {
  name: string;
  count: number;
  conversionFromPrevious: number | null; // %
  conversionFromStart: number | null; // %
}

export interface CohortRetentionOptions {
  /** Field marking the cohort-defining event (e.g. signup date). */
  cohortDateField: string;
  /** Field marking each activity/return event (can be the same field for simple recurrence). */
  activityDateField: string;
  /** Unique identity to track across cohort and activity (e.g. userId). */
  idField: string;
  cohortInterval: Interval;
  /** How many periods forward to measure retention for (e.g. 8 weeks). */
  periods: number;
}

export interface CohortRow {
  cohort: string; // ISO bucket start
  cohortSize: number;
  retention: (number | null)[]; // retained count per period offset, index 0 = period 0 (=cohortSize)
  retentionPct: (number | null)[];
}

export interface SessionizeOptions {
  userField: string;
  dateField: string;
  /** Idle gap (minutes) after which a new session starts. */
  gapMinutes: number;
}

export interface SessionSummary {
  userId: unknown;
  sessionStart: string;
  sessionEnd: string;
  eventCount: number;
  durationSeconds: number;
}

export interface OutlierRow {
  _id: unknown;
  value: number;
  zScore: number;
  [key: string]: unknown;
}

export class QueryAnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryAnalyticsError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTimezone(tz: string | undefined): string {
  const candidate = tz && tz.trim() ? tz.trim() : DEFAULT_TIMEZONE;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function shiftLocalDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return addDays(anchor, days).toISOString().slice(0, 10);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function rejectBannedStages(stage: unknown): void {
  if (Array.isArray(stage)) {
    stage.forEach(rejectBannedStages);
    return;
  }
  if (!isPlainObject(stage)) return;
  for (const k in stage) {
    if (BANNED_STAGE_OPERATORS.has(k)) {
      throw new QueryAnalyticsError(`Disallowed pipeline stage: "${k}"`);
    }
    rejectBannedStages(stage[k]);
  }
}

function buildGroupExpr(specs: StatSpec[]): Record<string, unknown> {
  const group: Record<string, unknown> = {};
  for (const spec of specs) {
    if (spec.op === 'count') {
      group[spec.name] = { $sum: 1 };
    } else if (spec.op === 'distinctCount') {
      if (!spec.field)
        throw new QueryAnalyticsError(
          `"${spec.name}" needs "field" for distinctCount`,
        );
      group[`__set_${spec.name}`] = { $addToSet: `$${spec.field}` };
    } else {
      if (!spec.field)
        throw new QueryAnalyticsError(
          `"${spec.name}" needs "field" for op "${spec.op}"`,
        );
      group[spec.name] = { [`$${spec.op}`]: `$${spec.field}` };
    }
  }
  return group;
}

function finalizeDistinctCounts(
  row: Record<string, unknown>,
  specs: StatSpec[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of specs) {
    if (spec.op === 'distinctCount') {
      const set = row[`__set_${spec.name}`] as unknown[] | undefined;
      out[spec.name] = Array.isArray(set) ? set.length : 0;
    } else {
      out[spec.name] = (row[spec.name] as number) ?? 0;
    }
  }
  return out;
}

function dateTruncStage(
  dateField: string,
  interval: Interval,
  timezone: string,
  weekStartsOn: number,
  outField = '__bucket',
): Stage {
  const unitMap: Record<Interval, string> = {
    hour: 'hour',
    day: 'day',
    week: 'week',
    month: 'month',
  };
  return {
    $addFields: {
      [outField]: {
        $dateTrunc: {
          date: `$${dateField}`,
          unit: unitMap[interval],
          timezone,
          ...(interval === 'week'
            ? {
                startOfWeek: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][
                  weekStartsOn
                ],
              }
            : {}),
        },
      },
    },
  };
}

function nextBucket(d: Date, interval: Interval): Date {
  switch (interval) {
    case 'hour':
      return addHours(d, 1);
    case 'day':
      return addDays(d, 1);
    case 'week':
      return addWeeks(d, 1);
    case 'month':
      return addMonths(d, 1);
  }
}

function periodOffset(from: Date, to: Date, interval: Interval): number {
  const msPerUnit: Record<Interval, number> = {
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000, // approximate; cohort bucketing itself is exact via $dateTrunc
  };
  return Math.round((to.getTime() - from.getTime()) / msPerUnit[interval]);
}

// ─── Tiny in-memory cache ───────────────────────────────────────────────────

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}
const _cacheStore = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | undefined {
  const hit = _cacheStore.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    _cacheStore.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (ttlMs <= 0) return;
  _cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ─── QueryAnalytics ─────────────────────────────────────────────────────────

export class QueryAnalytics<T> {
  private readonly model: Model<T>;
  private readonly options: Required<
    Omit<QueryAnalyticsOptions, 'cacheTTLMs'>
  > & { cacheTTLMs: number };

  private _serverConditions: Record<string, unknown> = {};
  private _extraStages: Stage[] = [];

  constructor(model: Model<T>, options: QueryAnalyticsOptions = {}) {
    this.model = model;
    this.options = {
      timezone: resolveTimezone(options.timezone),
      maxTimeMS: options.maxTimeMS ?? DEFAULT_MAX_TIME_MS,
      allowDiskUse: options.allowDiskUse ?? false,
      weekStartsOn: options.weekStartsOn ?? 6,
      cacheTTLMs: options.cacheTTLMs ?? 0,
    };
  }

  get timezone(): string {
    return this.options.timezone;
  }

  // ── Base filter (server-only; never client-overridable) ────────────────────

  /** Adds/merges a hard condition into the base $match. Call as many times as needed. */
  match(
    conditions: Partial<Record<keyof T, unknown>> | Record<string, unknown>,
  ): this {
    Object.assign(this._serverConditions, conditions);
    return this;
  }

  /** Escape hatch for extra developer-authored stages spliced in before analytics-specific stages. Blocks $out/$merge. */
  addStage(stage: PipelineStage): this {
    rejectBannedStages(stage);
    this._extraStages.push(stage as unknown as Stage);
    return this;
  }

  /** Hard local-date range condition on `field`, e.g. { from: '2026-08-01', to: '2026-08-31' } (inclusive). */
  dateRange(field: string, range: { from: string; to: string }): this {
    if (!PLAIN_DATE_RE.test(range.from) || !PLAIN_DATE_RE.test(range.to)) {
      throw new QueryAnalyticsError(
        `dateRange: "from"/"to" must be YYYY-MM-DD, got "${range.from}" / "${range.to}"`,
      );
    }
    const tz = this.options.timezone;
    const start = fromZonedTime(`${range.from}T00:00:00.000`, tz);
    const end = fromZonedTime(
      `${shiftLocalDateString(range.to, 1)}T00:00:00.000`,
      tz,
    );
    this._serverConditions[field] = { $gte: start, $lt: end };
    return this;
  }

  clone(): QueryAnalytics<T> {
    const c = new QueryAnalytics<T>(this.model, this.options);
    c._serverConditions = { ...this._serverConditions };
    c._extraStages = [...this._extraStages];
    return c;
  }

  private baseMatchStage(): Stage | null {
    return Object.keys(this._serverConditions).length > 0
      ? { $match: this._serverConditions }
      : null;
  }

  private basePipeline(): Stage[] {
    const pipeline: Stage[] = [];
    const m = this.baseMatchStage();
    if (m) pipeline.push(m);
    pipeline.push(...this._extraStages);
    return pipeline;
  }

  private async run<R = unknown>(
    pipeline: Stage[],
    cacheKey?: string,
  ): Promise<R[]> {
    const ttl = this.options.cacheTTLMs;
    if (ttl > 0 && cacheKey) {
      const hit = cacheGet<R[]>(cacheKey);
      if (hit) return hit;
    }
    // Single, deliberate boundary cast — see the Stage type comment above.
    const agg = this.model.aggregate<R>(pipeline as unknown as PipelineStage[]);
    if (this.options.maxTimeMS > 0)
      agg.option({ maxTimeMS: this.options.maxTimeMS });
    if (this.options.allowDiskUse) agg.allowDiskUse(true);
    const result = await agg.exec();
    if (ttl > 0 && cacheKey) cacheSet(cacheKey, result, ttl);
    return result;
  }

  /** Clears every cached analytics result (across all instances/models). */
  static clearCache(): void {
    _cacheStore.clear();
  }

  // ── Time series ──────────────────────────────────────────────────────────

  /**
   * Buckets documents by `dateField` into `interval`-sized, timezone-aligned
   * buckets and computes `metrics` per bucket. Fills gaps with zero-valued
   * buckets so charts never show a broken line for empty days.
   */
  async timeSeries(opts: {
    dateField: string;
    interval: Interval;
    metrics: StatSpec[];
    fillGaps?: boolean;
  }): Promise<TimeSeriesPoint[]> {
    const { dateField, interval, metrics, fillGaps = true } = opts;
    const pipeline: Stage[] = [
      ...this.basePipeline(),
      dateTruncStage(
        dateField,
        interval,
        this.options.timezone,
        this.options.weekStartsOn,
      ),
      { $group: { _id: '$__bucket', ...buildGroupExpr(metrics) } },
      { $sort: { _id: 1 } },
    ];

    const rows = await this.run<Record<string, unknown>>(pipeline);
    const points: TimeSeriesPoint[] = rows.map((r) => ({
      bucket: (r._id as Date).toISOString(),
      ...finalizeDistinctCounts(r, metrics),
    }));

    if (!fillGaps || points.length === 0) return points;

    const filled: TimeSeriesPoint[] = [];
    let cursor = new Date(points[0].bucket);
    const end = new Date(points[points.length - 1].bucket);
    const byBucket = new Map(points.map((p) => [p.bucket, p]));
    const zero = Object.fromEntries(metrics.map((m) => [m.name, 0]));

    while (cursor <= end) {
      const key = cursor.toISOString();
      filled.push(byBucket.get(key) ?? { bucket: key, ...zero });
      cursor = nextBucket(cursor, interval);
    }
    return filled;
  }

  /**
   * Same bucketing as timeSeries(), plus a native running-total column per
   * metric (computed server-side via $setWindowFields — no JS post-pass).
   */
  async cumulativeSeries(opts: {
    dateField: string;
    interval: Interval;
    metrics: StatSpec[];
  }): Promise<TimeSeriesPoint[]> {
    const { dateField, interval, metrics } = opts;
    const cumulativeFields: Record<string, unknown> = {};
    for (const spec of metrics) {
      if (spec.op === 'distinctCount') continue; // running distinct-count isn't a well-defined windowed sum
      cumulativeFields[`${spec.name}_cumulative`] = {
        $sum: `$${spec.name}`,
        window: { documents: ['unbounded', 'current'] },
      };
    }

    const pipeline: Stage[] = [
      ...this.basePipeline(),
      dateTruncStage(
        dateField,
        interval,
        this.options.timezone,
        this.options.weekStartsOn,
      ),
      { $group: { _id: '$__bucket', ...buildGroupExpr(metrics) } },
      { $sort: { _id: 1 } },
      {
        $setWindowFields: {
          sortBy: { _id: 1 },
          output: cumulativeFields,
        },
      },
    ];

    const rows = await this.run<Record<string, unknown>>(pipeline);
    return rows.map((r) => {
      const base = finalizeDistinctCounts(r, metrics);
      const cumulative: Record<string, number> = {};
      for (const spec of metrics) {
        if (spec.op === 'distinctCount') continue;
        cumulative[`${spec.name}_cumulative`] =
          (r[`${spec.name}_cumulative`] as number) ?? 0;
      }
      return { bucket: (r._id as Date).toISOString(), ...base, ...cumulative };
    });
  }

  // ── Period-over-period comparison ────────────────────────────────────────

  /**
   * Computes `metrics` for the current preset period and the equivalent
   * prior period, plus absolute and percentage change per metric.
   * Ignores any .dateRange() already applied — the preset defines both windows.
   */
  async compare(opts: {
    dateField: string;
    metrics: StatSpec[];
    preset: ComparePreset;
  }): Promise<CompareResult> {
    const { dateField, metrics, preset } = opts;
    const tz = this.options.timezone;
    const zonedNow = toZonedTime(new Date(), tz);
    const todayStr = format(zonedNow, 'yyyy-MM-dd');

    const rangeFor = (fromStr: string, toStr: string) => ({
      start: fromZonedTime(`${fromStr}T00:00:00.000`, tz),
      end: fromZonedTime(`${shiftLocalDateString(toStr, 1)}T00:00:00.000`, tz),
    });

    let curFrom: string, curTo: string, prevFrom: string, prevTo: string;
    switch (preset) {
      case 'today':
        curFrom = curTo = todayStr;
        prevFrom = prevTo = shiftLocalDateString(todayStr, -1);
        break;
      case 'last7Days':
        curFrom = shiftLocalDateString(todayStr, -6);
        curTo = todayStr;
        prevFrom = shiftLocalDateString(todayStr, -13);
        prevTo = shiftLocalDateString(todayStr, -7);
        break;
      case 'last30Days':
        curFrom = shiftLocalDateString(todayStr, -29);
        curTo = todayStr;
        prevFrom = shiftLocalDateString(todayStr, -59);
        prevTo = shiftLocalDateString(todayStr, -30);
        break;
      case 'thisWeek': {
        const weekStart = format(
          startOfWeek(zonedNow, { weekStartsOn: this.options.weekStartsOn }),
          'yyyy-MM-dd',
        );
        curFrom = weekStart;
        curTo = todayStr;
        const spanDays =
          Math.round(
            (new Date(curTo).getTime() - new Date(curFrom).getTime()) /
              86400000,
          ) + 1;
        prevTo = shiftLocalDateString(weekStart, -1);
        prevFrom = shiftLocalDateString(prevTo, -(spanDays - 1));
        break;
      }
      case 'thisMonth': {
        const monthStart = format(startOfMonth(zonedNow), 'yyyy-MM-dd');
        curFrom = monthStart;
        curTo = todayStr;
        const prevMonthEnd = shiftLocalDateString(monthStart, -1);
        const spanDays =
          Math.round(
            (new Date(curTo).getTime() - new Date(curFrom).getTime()) /
              86400000,
          ) + 1;
        prevTo = prevMonthEnd;
        prevFrom = shiftLocalDateString(prevMonthEnd, -(spanDays - 1));
        break;
      }
      default:
        throw new QueryAnalyticsError(`Unknown compare preset: "${preset}"`);
    }

    const cur = rangeFor(curFrom, curTo);
    const prev = rangeFor(prevFrom, prevTo);

    const runFor = async (
      start: Date,
      end: Date,
    ): Promise<Record<string, number>> => {
      const pipeline: Stage[] = [
        {
          $match: {
            ...this._serverConditions,
            [dateField]: { $gte: start, $lt: end },
          },
        },
        ...this._extraStages,
        { $group: { _id: null, ...buildGroupExpr(metrics) } },
      ];
      const [row] = await this.run<Record<string, unknown>>(pipeline);
      return finalizeDistinctCounts(row ?? {}, metrics);
    };

    const [current, previous] = await Promise.all([
      runFor(cur.start, cur.end),
      runFor(prev.start, prev.end),
    ]);

    const change: Record<string, number> = {};
    const changePct: Record<string, number | null> = {};
    for (const spec of metrics) {
      const c = current[spec.name] ?? 0;
      const p = previous[spec.name] ?? 0;
      change[spec.name] = c - p;
      changePct[spec.name] =
        p === 0 ? null : Number((((c - p) / p) * 100).toFixed(2));
    }

    return { current, previous, change, changePct };
  }

  // ── Breakdown / Top-N by dimension ───────────────────────────────────────

  /** Groups by `field` and computes `metrics` per group, sorted and capped. */
  async breakdown(
    field: string,
    metrics: StatSpec[],
    opts: { limit?: number; sortBy?: string; sortDir?: 1 | -1 } = {},
  ): Promise<BreakdownRow[]> {
    const { limit = 10, sortDir = -1 } = opts;
    const sortBy = opts.sortBy ?? metrics[0]?.name ?? '_id';

    const pipeline: Stage[] = [
      ...this.basePipeline(),
      { $group: { _id: `$${field}`, ...buildGroupExpr(metrics) } },
      { $sort: { [sortBy]: sortDir } },
      { $limit: limit },
    ];

    const rows = await this.run<Record<string, unknown>>(pipeline);
    return rows.map((r) => ({
      key: r._id,
      ...finalizeDistinctCounts(r, metrics),
    }));
  }

  /** Same as breakdown(), but adds a native dense-rank column (1-based) via $setWindowFields — no client-side re-sorting needed. */
  async rankedBreakdown(
    field: string,
    metrics: StatSpec[],
    opts: { limit?: number; sortBy?: string; sortDir?: 1 | -1 } = {},
  ): Promise<RankedBreakdownRow[]> {
    const { limit = 10, sortDir = -1 } = opts;
    const sortBy = opts.sortBy ?? metrics[0]?.name ?? '_id';

    const pipeline: Stage[] = [
      ...this.basePipeline(),
      { $group: { _id: `$${field}`, ...buildGroupExpr(metrics) } },
      {
        $setWindowFields: {
          sortBy: { [sortBy]: sortDir },
          output: { __rank: { $denseRank: {} } },
        },
      },
      { $sort: { [sortBy]: sortDir } },
      { $limit: limit },
    ];

    const rows = await this.run<Record<string, unknown>>(pipeline);
    return rows.map((r) => ({
      key: r._id,
      rank: r.__rank as number,
      ...finalizeDistinctCounts(r, metrics),
    }));
  }

  /** Pivot table: groups by two dimensions at once, returning one row per (dimA, dimB) pair with metrics. */
  async multiBreakdown(
    fields: [string, string],
    metrics: StatSpec[],
    opts: { limit?: number } = {},
  ): Promise<(BreakdownRow & { key2: unknown })[]> {
    const [f1, f2] = fields;
    const pipeline: Stage[] = [
      ...this.basePipeline(),
      {
        $group: {
          _id: { a: `$${f1}`, b: `$${f2}` },
          ...buildGroupExpr(metrics),
        },
      },
      { $sort: { '_id.a': 1, '_id.b': 1 } },
      ...(opts.limit ? [{ $limit: opts.limit } as Stage] : []),
    ];
    const rows = await this.run<Record<string, unknown>>(pipeline);
    return rows.map((r) => {
      const id = r._id as { a: unknown; b: unknown };
      return { key: id.a, key2: id.b, ...finalizeDistinctCounts(r, metrics) };
    });
  }

  // ── Funnel ────────────────────────────────────────────────────────────────

  /**
   * Sequential funnel: each step's count is the number of base documents
   * matching that step's `match` condition ANDed with the base filter.
   * Steps are independent counts — pass cumulative conditions yourself if
   * step N should imply step N-1.
   */
  async funnel(steps: FunnelStep[]): Promise<FunnelResult[]> {
    if (steps.length === 0) return [];
    const counts = await Promise.all(
      steps.map((step) => {
        const pipeline: Stage[] = [
          { $match: { ...this._serverConditions, ...step.match } },
          ...this._extraStages,
          { $count: 'count' },
        ];
        return this.run<{ count: number }>(pipeline).then(
          (r) => r[0]?.count ?? 0,
        );
      }),
    );

    const startCount = counts[0] || 0;
    return steps.map((step, i) => ({
      name: step.name,
      count: counts[i],
      conversionFromPrevious:
        i === 0
          ? null
          : counts[i - 1] === 0
            ? null
            : Number(((counts[i] / counts[i - 1]) * 100).toFixed(2)),
      conversionFromStart:
        i === 0
          ? null
          : startCount === 0
            ? null
            : Number(((counts[i] / startCount) * 100).toFixed(2)),
    }));
  }

  // ── Cohort retention ──────────────────────────────────────────────────────

  /**
   * Buckets entities by their cohort period (first occurrence of
   * `cohortDateField`) and, for each cohort, counts distinct `idField`s with
   * an activity (`activityDateField`) in each subsequent period offset
   * (0 = the cohort period itself). Good for classic "% of signups still
   * active N weeks later" retention tables.
   */
  async cohortRetention(opts: CohortRetentionOptions): Promise<CohortRow[]> {
    const {
      cohortDateField,
      activityDateField,
      idField,
      cohortInterval,
      periods,
    } = opts;
    const tz = this.options.timezone;
    const wso = this.options.weekStartsOn;

    // Cohort assignment: bucket of cohortDateField per entity.
    const cohortPipeline: Stage[] = [
      ...this.basePipeline(),
      dateTruncStage(cohortDateField, cohortInterval, tz, wso, '__cohort'),
      { $group: { _id: `$${idField}`, cohort: { $min: '$__cohort' } } },
    ];
    const cohortRows = await this.run<{ _id: unknown; cohort: Date }>(
      cohortPipeline,
    );
    const cohortById = new Map(
      cohortRows.map((r) => [String(r._id), r.cohort]),
    );

    // Activity bucket per entity per period.
    const activityPipeline: Stage[] = [
      ...this.basePipeline(),
      dateTruncStage(activityDateField, cohortInterval, tz, wso, '__activity'),
      { $group: { _id: { id: `$${idField}`, bucket: '$__activity' } } },
    ];
    const activityRows = await this.run<{ _id: { id: unknown; bucket: Date } }>(
      activityPipeline,
    );

    const cohortSizes = new Map<string, Set<string>>();
    for (const [id, cohort] of cohortById) {
      const key = cohort.toISOString();
      if (!cohortSizes.has(key)) cohortSizes.set(key, new Set());
      cohortSizes.get(key)!.add(id);
    }

    // retained[cohortKey][periodOffset] = Set of ids active in that offset
    const retained = new Map<string, Map<number, Set<string>>>();
    for (const row of activityRows) {
      const id = String(row._id.id);
      const cohort = cohortById.get(id);
      if (!cohort) continue;
      const offset = periodOffset(cohort, row._id.bucket, cohortInterval);
      if (offset < 0 || offset > periods) continue;
      const cohortKey = cohort.toISOString();
      if (!retained.has(cohortKey)) retained.set(cohortKey, new Map());
      const byOffset = retained.get(cohortKey)!;
      if (!byOffset.has(offset)) byOffset.set(offset, new Set());
      byOffset.get(offset)!.add(id);
    }

    const cohortKeys = Array.from(cohortSizes.keys()).sort();
    return cohortKeys.map((cohortKey) => {
      const size = cohortSizes.get(cohortKey)!.size;
      const byOffset = retained.get(cohortKey) ?? new Map();
      const retention: (number | null)[] = [];
      const retentionPct: (number | null)[] = [];
      for (let offset = 0; offset <= periods; offset++) {
        const count = byOffset.get(offset)?.size ?? (offset === 0 ? size : 0);
        retention.push(count);
        retentionPct.push(
          size === 0 ? null : Number(((count / size) * 100).toFixed(2)),
        );
      }
      return { cohort: cohortKey, cohortSize: size, retention, retentionPct };
    });
  }

  // ── Sessionization ────────────────────────────────────────────────────────

  /**
   * Groups per-user events into sessions using native $setWindowFields +
   * $shift gap detection (a session breaks when the idle gap since the
   * previous event exceeds `gapMinutes`), then summarizes each session.
   */
  async sessionize(opts: SessionizeOptions): Promise<SessionSummary[]> {
    const { userField, dateField, gapMinutes } = opts;
    const gapMs = gapMinutes * 60 * 1000;

    const pipeline: Stage[] = [
      ...this.basePipeline(),
      { $sort: { [userField]: 1, [dateField]: 1 } },
      {
        $setWindowFields: {
          partitionBy: `$${userField}`,
          sortBy: { [dateField]: 1 },
          output: { __prevTs: { $shift: { output: `$${dateField}`, by: -1 } } },
        },
      },
      {
        $addFields: {
          __newSession: {
            $cond: [
              { $eq: ['$__prevTs', null] },
              1,
              { $gt: [{ $subtract: [`$${dateField}`, '$__prevTs'] }, gapMs] },
            ],
          },
        },
      },
      {
        $setWindowFields: {
          partitionBy: `$${userField}`,
          sortBy: { [dateField]: 1 },
          output: {
            __sessionIndex: {
              $sum: { $cond: ['$__newSession', 1, 0] },
              window: { documents: ['unbounded', 'current'] },
            },
          },
        },
      },
      {
        $group: {
          _id: { user: `$${userField}`, session: '$__sessionIndex' },
          sessionStart: { $min: `$${dateField}` },
          sessionEnd: { $max: `$${dateField}` },
          eventCount: { $sum: 1 },
        },
      },
      { $sort: { sessionStart: 1 } },
    ];

    const rows = await this.run<{
      _id: { user: unknown; session: number };
      sessionStart: Date;
      sessionEnd: Date;
      eventCount: number;
    }>(pipeline);
    return rows.map((r) => ({
      userId: r._id.user,
      sessionStart: r.sessionStart.toISOString(),
      sessionEnd: r.sessionEnd.toISOString(),
      eventCount: r.eventCount,
      durationSeconds: Math.round(
        (r.sessionEnd.getTime() - r.sessionStart.getTime()) / 1000,
      ),
    }));
  }

  // ── Percentiles & outliers ────────────────────────────────────────────────

  /** Computes percentiles (0-100) of `field` over the current filter, using native $percentile. */
  async percentiles(
    field: string,
    ps: number[],
  ): Promise<Record<string, number | null>> {
    const pipeline: Stage[] = [
      ...this.basePipeline(),
      {
        $group: {
          _id: null,
          values: {
            $percentile: {
              input: `$${field}`,
              p: ps.map((p) => p / 100),
              method: 'approximate',
            },
          },
        },
      },
    ];
    const [row] = await this.run<{ values: number[] }>(pipeline);
    const out: Record<string, number | null> = {};
    ps.forEach((p, i) => {
      out[`p${p}`] = row?.values?.[i] ?? null;
    });
    return out;
  }

  /**
   * Flags documents whose `field` value is more than `threshold` standard
   * deviations from the mean (native $stdDevPop, single extra pass to fetch
   * the flagged rows). Good for a quick "anomalies" widget.
   */
  async stdDevOutliers(
    field: string,
    opts: { threshold?: number; limit?: number } = {},
  ): Promise<OutlierRow[]> {
    const threshold = opts.threshold ?? 3;
    const limit = opts.limit ?? 50;

    const [stats] = await this.run<{ mean: number; stdDev: number }>([
      ...this.basePipeline(),
      {
        $group: {
          _id: null,
          mean: { $avg: `$${field}` },
          stdDev: { $stdDevPop: `$${field}` },
        },
      },
    ]);
    if (!stats || !stats.stdDev) return [];

    const pipeline: Stage[] = [
      ...this.basePipeline(),
      {
        $addFields: {
          __z: {
            $divide: [{ $subtract: [`$${field}`, stats.mean] }, stats.stdDev],
          },
        },
      },
      { $match: { __z: { $not: { $gte: -threshold, $lte: threshold } } } },
      { $sort: { __z: -1 } },
      { $limit: limit },
    ];

    const rows = await this.run<Record<string, unknown>>(pipeline);
    return rows.map((r) => ({
      _id: r._id,
      value: r[field] as number,
      zScore: Number((r.__z as number).toFixed(3)),
      ...r,
    }));
  }

  // ── One-shot multi-metric summary ─────────────────────────────────────────

  /** Computes several independent StatSpec metrics in one aggregate call — cheaper than N separate calls for a KPI-strip widget. */
  async metrics(specs: StatSpec[]): Promise<Record<string, number>> {
    const pipeline: Stage[] = [
      ...this.basePipeline(),
      { $group: { _id: null, ...buildGroupExpr(specs) } },
    ];
    const [row] = await this.run<Record<string, unknown>>(pipeline);
    return finalizeDistinctCounts(row ?? {}, specs);
  }

  // ── Moving average, trend, forecast (pure JS post-processing) ────────────

  /** Adds a trailing moving average over an already-fetched time series. */
  static movingAverage(
    series: TimeSeriesPoint[],
    metric: string,
    windowSize: number,
    outKey = `${metric}_ma`,
  ): TimeSeriesPoint[] {
    if (windowSize < 1)
      throw new QueryAnalyticsError('movingAverage: windowSize must be >= 1');
    return series.map((point, i) => {
      const start = Math.max(0, i - windowSize + 1);
      const window = series.slice(start, i + 1);
      const sum = window.reduce((acc, p) => acc + (Number(p[metric]) || 0), 0);
      return { ...point, [outKey]: Number((sum / window.length).toFixed(4)) };
    });
  }

  /** Simple up/down/flat trend classification comparing the average of the last `n` points to the `n` before that. */
  static trend(
    series: TimeSeriesPoint[],
    metric: string,
    n = 3,
    flatThresholdPct = 2,
  ): 'up' | 'down' | 'flat' | 'insufficient_data' {
    if (series.length < n * 2) return 'insufficient_data';
    const recent = series.slice(-n);
    const prior = series.slice(-2 * n, -n);
    const avg = (arr: TimeSeriesPoint[]) =>
      arr.reduce((a, p) => a + (Number(p[metric]) || 0), 0) / arr.length;
    const recentAvg = avg(recent);
    const priorAvg = avg(prior);
    if (priorAvg === 0) return recentAvg === 0 ? 'flat' : 'up';
    const pctChange = ((recentAvg - priorAvg) / priorAvg) * 100;
    if (Math.abs(pctChange) < flatThresholdPct) return 'flat';
    return pctChange > 0 ? 'up' : 'down';
  }

  /** Simple linear-regression forecast for `periodsAhead` future buckets, based on the existing series' trend line. Good enough for a dashed projection line — not a substitute for real forecasting models. */
  static forecast(
    series: TimeSeriesPoint[],
    metric: string,
    periodsAhead: number,
  ): { index: number; predicted: number }[] {
    const n = series.length;
    if (n < 2) return [];
    const xs = series.map((_, i) => i);
    const ys = series.map((p) => Number(p[metric]) || 0);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = yMean - slope * xMean;
    const out: { index: number; predicted: number }[] = [];
    for (let i = 1; i <= periodsAhead; i++) {
      const x = n - 1 + i;
      out.push({
        index: x,
        predicted: Number((slope * x + intercept).toFixed(4)),
      });
    }
    return out;
  }

  // ── Heatmap (hour-of-day x day-of-week) ──────────────────────────────────

  /** Counts (or sums `valueField`) by weekday (0=Sun..6=Sat, local tz) x hour-of-day (0-23, local tz). */
  async heatmap(
    dateField: string,
    valueField?: string,
  ): Promise<{ weekday: number; hour: number; value: number }[]> {
    const tz = this.options.timezone;
    const pipeline: Stage[] = [
      ...this.basePipeline(),
      {
        $addFields: {
          __weekday: {
            $subtract: [
              { $dayOfWeek: { date: `$${dateField}`, timezone: tz } },
              1,
            ],
          },
          __hour: { $hour: { date: `$${dateField}`, timezone: tz } },
        },
      },
      {
        $group: {
          _id: { weekday: '$__weekday', hour: '$__hour' },
          value: valueField ? { $sum: `$${valueField}` } : { $sum: 1 },
        },
      },
      { $sort: { '_id.weekday': 1, '_id.hour': 1 } },
    ];
    const rows = await this.run<{
      _id: { weekday: number; hour: number };
      value: number;
    }>(pipeline);
    return rows.map((r) => ({
      weekday: r._id.weekday,
      hour: r._id.hour,
      value: r.value,
    }));
  }

  // ── Live updates ──────────────────────────────────────────────────────────

  /**
   * Subscribes to a MongoDB change stream on this model's collection and
   * invokes `onChange` for every insert/update/delete/replace matching the
   * current .match() filter (translated to a $match on `fullDocument`
   * fields). Returns the underlying ChangeStream so the caller can
   * `.close()` it. Useful for pushing live dashboard updates over a
   * websocket instead of polling.
   */
  watch(
    onChange: (change: unknown) => void,
    opts: { operationTypes?: string[] } = {},
  ): ReturnType<Model<T>['watch']> {
    const matchStage: Record<string, unknown> = {};
    if (opts.operationTypes?.length)
      matchStage.operationType = { $in: opts.operationTypes };
    for (const [k, v] of Object.entries(this._serverConditions)) {
      matchStage[`fullDocument.${k}`] = v;
    }
    // Model.watch()'s pipeline param is typed as Record<string, unknown>[] (unlike
    // aggregate()'s PipelineStage[]) — pipeline already matches that shape as-is.
    const pipeline: Record<string, unknown>[] =
      Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : [];
    const stream = this.model.watch(pipeline, { fullDocument: 'updateLookup' });
    stream.on('change', onChange);
    return stream;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /** Flattens an array of plain-object rows into a CSV string (handy for timeSeries/breakdown results). */
  static toCSV(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return '';
    const headers = Array.from(
      rows.reduce((set, r) => {
        Object.keys(r).forEach((k) => set.add(k));
        return set;
      }, new Set<string>()),
    );
    const escape = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
    ];
    return lines.join('\n');
  }

  /** Newline-delimited JSON export — friendlier than a giant JSON array for streaming large exports to disk/S3. */
  static toNDJSON(rows: Record<string, unknown>[]): string {
    return rows.map((r) => JSON.stringify(r)).join('\n');
  }

  // ── Dashboard batch runner ────────────────────────────────────────────────

  /**
   * Runs several named analytics calls in parallel and returns them keyed by
   * name — for building a whole dashboard in one round trip from the
   * caller's perspective.
   */
  static async dashboard<R extends Record<string, () => Promise<unknown>>>(
    tasks: R,
  ): Promise<{ [K in keyof R]: Awaited<ReturnType<R[K]>> }> {
    const keys = Object.keys(tasks) as (keyof R)[];
    const results = await Promise.all(keys.map((k) => tasks[k]()));
    const out = {} as { [K in keyof R]: Awaited<ReturnType<R[K]>> };
    keys.forEach((k, i) => {
      out[k] = results[i] as Awaited<ReturnType<R[typeof k]>>;
    });
    return out;
  }
}

export default QueryAnalytics;
