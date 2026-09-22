/**
 * QueryAggregate - Fluent, allowlisted aggregation-pipeline builder for Mongoose (v8/v9)
 *
 * `QueryFind` (mongoose-query-find) is built on `Model.find()` and can't express
 * `$lookup` joins, `$group`, or other pipeline-only stages. QueryAggregate mirrors
 * the same safety model (allowlisted filter fields, sanitized operators, capped
 * pagination) but is built on `Model.aggregate()`.
 *
 * ── Timezone handling ───────────────────────────────────────────────────────
 * MongoDB always stores/compares dates in UTC. Clients think and filter in local
 * time (e.g. ?createdAt=2026-09-01 means "Sept 1st in the caller's timezone",
 * not UTC midnight). This builder resolves that with `date-fns-tz`:
 *
 *   - fromZonedTime(localString, tz) -> the exact UTC instant for a wall-clock
 *     time in `tz`. Used to turn a client-supplied local date into the correct
 *     $gte/$lt UTC range for the pipeline's $match stage.
 *   - toZonedTime(utcDate, tz)       -> the wall-clock Date for `tz`. Used to
 *     work out "what day is it right now, in the caller's timezone" for
 *     relative presets like .range('today').
 *
 * The timezone itself is a per-request value, passed in via constructor
 * options rather than hardcoded, typically sourced from a header:
 *
 *   const timezone = (req.headers['x-timezone'] as string) ?? 'Asia/Dhaka';
 *
 *   const result = await new QueryAggregate(CategoryModel, req.query, { timezone })
 *     .allowFields(['name', 'status', 'createdAt'])
 *     .dateFields(['createdAt', 'updatedAt'])
 *     .where({ branchId: req.self.linkedTo, status: { $ne: CategoryStatus.ARCHIVED } })
 *     .filter()
 *     .globalSearch(['name'])
 *     .sort()
 *     .project('name status createdAt updatedAt')
 *     .paginate();
 *
 * An invalid/unknown IANA timezone string (bad header, typo, etc.) never
 * throws mid-query — it's validated once at construction time and falls back
 * to the default.
 *
 * ── Joins ────────────────────────────────────────────────────────────────────
 * Use .lookup() for $lookup (+ optional $unwind), or .addStage() to inject any
 * other developer-authored stage. .addStage() is for trusted, server-defined
 * stages — it only blocks destructive stage types ($out/$merge). It does NOT
 * run the client-input sanitizer; that only applies to .filter()/.where(),
 * which parse untrusted req.query / req.body values.
 *
 * ── Custom ranges ────────────────────────────────────────────────────────────
 * `.range(field, preset)` covers the fixed RangePreset values (today,
 * yesterday, last7Days, last30Days, thisWeek, thisMonth). For anything more
 * specific — a single arbitrary day, an arbitrary date span, a rolling
 * window of N days/hours, an explicit hour-of-day window, or an explicit
 * absolute datetime window — use the new custom range methods below:
 *
 *   .rangeCustomDay(field, '2026-03-14')
 *   .rangeBetween(field, { from: '2026-01-01', to: '2026-01-31' })
 *   .rangeLastNDays(field, 14)
 *   .rangeLastNHours(field, 6)
 *   .rangeHours(field, { date: '2026-03-14', fromHour: 9, toHour: 17 })
 *   .rangeCustom(field, { from: '2026-03-14T09:00:00', to: '2026-03-15T00:00:00' })
 *
 * All of these behave like .range(): they set a hard, server-side condition
 * that the client cannot override via query params.
 */

import { addDays, format, startOfMonth, startOfWeek } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { isValidObjectId, Model, PipelineStage, Types } from 'mongoose';

// ─── Constants ────────────────────────────────────────────────────────────────

const RESERVED_KEYS = new Set<string>(['page', 'sort', 'limit', 'fields', 'q']);
const DEFAULT_MAX_LIMIT = 100;
const MAX_NESTING_DEPTH = 5;
const MAX_SEARCH_LENGTH = 200;
const MAX_SORT_FIELDS = 5;
const DEFAULT_MAX_TIME_MS = 5_000;
const DEFAULT_TIMEZONE = 'Asia/Dhaka';

// Matches only when the date-word is the LAST path segment (e.g. "createdAt",
// "user.updatedAt") — used as a fallback heuristic when .dateFields() isn't
// called explicitly.
const DATE_FIELD_RE =
  /(^|\.)(createdAt|updatedAt|deletedAt|archivedAt|expiresAt|date|birthDate)$/i;
const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A string that already carries its own UTC offset ("Z" or "+06:00") is
// treated as an absolute instant rather than a local wall-clock time.
const HAS_OFFSET_RE = /([Zz]|[+-]\d{2}:?\d{2})$/;

// Matches only when the id-word is the LAST path segment (e.g. "_id",
// "categoryId", "basicInfo.brandId") — used as a fallback heuristic when
// .objectIdFields() isn't called explicitly. Mirrors DATE_FIELD_RE's approach.
const OBJECTID_FIELD_RE = /(^|\.)(_id|[a-zA-Z0-9]*Id)$/;
// A 24-char lowercase/uppercase hex string — the only shape isValidObjectId()
// should be trusted to interpret as "meant to be an ObjectId" rather than a
// 12-byte-length string that happens to also pass Mongoose's looser check.
const HEX24_RE = /^[a-fA-F0-9]{24}$/;

const COERCIBLE_OPS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
]);
const IN_LIKE_OPS = new Set(['in', '$in', 'nin', '$nin']);

const DEFAULT_SORT: Record<string, 1 | -1> = { createdAt: -1 };
const ALLOWED_TOP_LEVEL_OPS = new Set(['$and', '$or', '$nor', '$not']);
// Rejected anywhere inside client-supplied filter/search/populate-match input.
const BANNED_OPERATORS = new Set([
  '$where',
  '$expr',
  '$function',
  '$accumulator',
  '$map',
  '$reduce',
  '$filter',
]);
// Rejected in developer-authored pipeline stages added via addStage()/lookup()
// pipelines — these can mutate or drop data and have no place in a query builder.
const BANNED_STAGE_OPERATORS = new Set(['$out', '$merge']);

// ─── Public types ─────────────────────────────────────────────────────────────

export interface QueryParams {
  page?: string;
  limit?: string;
  sort?: string;
  fields?: string;
  q?: string;
  [key: string]: unknown;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
  limit: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface SlowQueryInfo {
  elapsedMs: number;
  pipeline: PipelineStage[];
  sort: Record<string, 1 | -1>;
  page: number;
  limit: number;
}

export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'last7Days'
  | 'last30Days'
  | 'thisWeek'
  | 'thisMonth';

// ── Custom range input types (additive — used by the new rangeXxx() methods
// below, alongside the existing RangePreset-driven .range()) ────────────────

/** A single arbitrary local calendar date, e.g. "2026-03-14". */
export type CustomDayInput = string;

/** An inclusive local-date span, e.g. { from: '2026-01-01', to: '2026-01-31' }. */
export interface CustomDateRangeInput {
  from: string;
  to: string;
}

/** An explicit hour-of-day window on a given local date (0–24, `toHour` exclusive; pass 24 for "through end of day"). */
export interface CustomHourRangeInput {
  date: string;
  fromHour: number;
  toHour: number;
}

/**
 * An explicit absolute datetime window. Each of `from`/`to` accepts:
 *   - "YYYY-MM-DD"              -> local midnight in this instance's timezone
 *   - "YYYY-MM-DDTHH:mm:ss[.sss]" -> local wall-clock time in this instance's timezone
 *   - an offset-bearing ISO string ("...Z" / "...+06:00") -> absolute instant
 */
export interface CustomDateTimeRangeInput {
  from: string;
  to: string;
}

// ── Advanced feature types (additive) ───────────────────────────────────────

/** Options for .paginateCursor() — keyset/seek pagination, better than skip/limit on large collections. */
export interface CursorPaginateOptions {
  /** Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
  cursor?: string;
  /** Overrides the instance's parsed ?limit=, capped by maxLimit like normal pagination. */
  limit?: number;
}

export interface CursorPaginatedResult<T> {
  data: T[];
  limit: number;
  /** Pass this back as `cursor` to fetch the next page; null when there are no more results. */
  nextCursor: string | null;
  hasNextPage: boolean;
}

/** One aggregate metric for .stats() — e.g. { name: 'revenue', op: 'sum', field: 'total' }. */
export interface StatSpec {
  name: string;
  op: 'sum' | 'avg' | 'min' | 'max' | 'count';
  /** Required for every op except 'count'. */
  field?: string;
}

export interface LookupOptions {
  /** Collection name (not the model name) to join against. */
  from: string;
  /** Output array field name. */
  as: string;
  localField?: string;
  foreignField?: string;
  /** Sub-pipeline form of $lookup — use instead of localField/foreignField for complex joins. */
  pipeline?: Exclude<PipelineStage, PipelineStage.Merge | PipelineStage.Out>[];
  /** When true, $unwind the joined array (preserveNullAndEmptyArrays: true) so `as` becomes a single object. */
  single?: boolean;
}

export interface QueryAggregateOptions {
  /** IANA timezone used to interpret client-supplied local dates, e.g. "Asia/Dhaka". Validated at construction; invalid values fall back to the default. */
  timezone?: string;
  maxTimeMS?: number;
  /** Threshold in ms above which onSlowQuery fires. Defaults to maxTimeMS. */
  slowQueryThresholdMS?: number;
  /** Maximum allowed `limit` per page. Defaults to 100. */
  maxLimit?: number;
  /** Forwarded to .allowDiskUse() — enable for large sort/group-heavy pipelines. */
  allowDiskUse?: boolean;
  /** 0 (Sun) – 6 (Sat). Used by range('thisWeek'). Defaults to 6 (Saturday). */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  onSlowQuery?: (info: SlowQueryInfo) => void;
  onSanitizeDrop?: (path: string, value: unknown) => void;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class QueryAggregateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryAggregateError';
  }
}

export class QueryAggregateValidationError extends QueryAggregateError {
  constructor(message: string) {
    super(message);
    this.name = 'QueryAggregateValidationError';
  }
}

// ─── Input parsing ────────────────────────────────────────────────────────────

function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? '1', 10);
  return isNaN(n) || n < 1 ? 1 : n;
}

function parseLimit(
  raw: string | undefined,
  maxLimit = DEFAULT_MAX_LIMIT,
): number {
  const n = parseInt(raw ?? '10', 10);
  if (isNaN(n) || n < 1) return 10;
  return Math.min(n, maxLimit);
}

function resolveTimezone(tz: string | undefined): string {
  const candidate = tz && tz.trim() ? tz.trim() : DEFAULT_TIMEZONE;
  try {
    // Throws RangeError on an invalid IANA zone — cheapest available validator.
    Intl.DateTimeFormat(undefined, { timeZone: candidate });
    return candidate;
  } catch {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[query-aggregate] Invalid timezone "${candidate}", falling back to "${DEFAULT_TIMEZONE}"`,
      );
    }
    return DEFAULT_TIMEZONE;
  }
}

// ─── Timezone-aware date helpers ───────────────────────────────────────────────

/** Shifts a "YYYY-MM-DD" string by N calendar days (pure date math, DST-safe via a noon-UTC anchor). */
function shiftLocalDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const shifted = addDays(anchor, days);
  return shifted.toISOString().slice(0, 10);
}

/** [start, end) UTC instants for a single local calendar date in `timezone`. */
function plainDateToUtcRange(
  dateStr: string,
  timezone: string,
): { start: Date; end: Date } {
  const start = fromZonedTime(`${dateStr}T00:00:00.000`, timezone);
  const end = fromZonedTime(
    `${shiftLocalDateString(dateStr, 1)}T00:00:00.000`,
    timezone,
  );
  return { start, end };
}

/** Parses a single date/datetime string to a scalar UTC Date (used for $in/$nin, where a range object isn't valid). */
function coerceDateScalar(value: string, timezone: string): Date | undefined {
  const raw = PLAIN_DATE_RE.test(value) ? `${value}T00:00:00.000` : value;
  const parsed = HAS_OFFSET_RE.test(value)
    ? new Date(value)
    : fromZonedTime(raw, timezone);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

function isDateField(path: string, explicit: Set<string> | null): boolean {
  if (!path) return false;
  const lc = path.toLowerCase();
  if (explicit && explicit.size > 0) {
    if (explicit.has(lc)) return true;
    const lastSeg = lc.split('.').pop() ?? lc;
    return explicit.has(lastSeg);
  }
  return DATE_FIELD_RE.test(path);
}

function isObjectIdField(path: string, explicit: Set<string> | null): boolean {
  if (!path) return false;
  const lc = path.toLowerCase();
  if (explicit && explicit.size > 0) {
    if (explicit.has(lc)) return true;
    const lastSeg = lc.split('.').pop() ?? lc;
    return explicit.has(lastSeg);
  }
  return OBJECTID_FIELD_RE.test(path);
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

/** Recursively strips non-plain values (class instances, functions) from client input. */
function sanitize(
  value: unknown,
  depth = 0,
  path = '',
  onDrop?: (path: string, value: unknown) => void,
): unknown {
  if (depth >= MAX_NESTING_DEPTH) {
    if (onDrop) onDrop(path, value);
    else if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[query-aggregate] Max nesting depth exceeded at "${path}":`,
        value,
      );
    }
    return undefined;
  }

  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (value instanceof Date) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const s = sanitize(value[i], depth + 1, `${path}[${i}]`, onDrop);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  if (t === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) {
        const childPath = path ? `${path}.${k}` : k;
        const s = sanitize(src[k], depth + 1, childPath, onDrop);
        if (s !== undefined) out[k] = s;
      }
    }
    return out;
  }

  if (onDrop) onDrop(path, value);
  else if (process.env.NODE_ENV !== 'production') {
    console.warn(
      `[query-aggregate] Dropped non-plain value at "${path}":`,
      value,
    );
  }
  return undefined;
}

// ─── Allowlist ─────────────────────────────────────────────────────────────────

function buildAllowedStructures(allowedFields: Set<string>): {
  lookup: Set<string>;
  canonical: Map<string, string>;
} {
  const lookup = new Set<string>();
  const canonical = new Map<string, string>();
  for (const f of allowedFields) {
    const lc = f.toLowerCase();
    lookup.add(lc);
    canonical.set(lc, f);
  }
  return { lookup, canonical };
}

function isFieldAllowed(field: string, allowedLookup: Set<string>): boolean {
  return allowedLookup.has(field.toLowerCase());
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

/** Strips any non-operator key not present in the allowlist; recurses into logical operators. */
function enforceAllowlist(
  filter: Record<string, unknown>,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
): Record<string, unknown> {
  if (allowedLookup.size === 0) return filter;

  const out: Record<string, unknown> = {};
  for (const k in filter) {
    if (!Object.prototype.hasOwnProperty.call(filter, k)) continue;
    const v = filter[k];

    if (k.startsWith('$')) {
      if (Array.isArray(v)) {
        out[k] = v.map((item) =>
          isPlainObject(item)
            ? enforceAllowlist(item, allowedLookup, canonicalMap)
            : item,
        );
      } else if (isPlainObject(v)) {
        out[k] = enforceAllowlist(v, allowedLookup, canonicalMap);
      } else {
        out[k] = v;
      }
      continue;
    }

    const lc = k.toLowerCase();
    if (allowedLookup.has(lc)) out[canonicalMap.get(lc) ?? k] = v;
  }
  return out;
}

// ─── Fused coercion pass (timezone-aware) ──────────────────────────────────────

function coerceAll(
  value: unknown,
  timezone: string,
  dateFieldsLookup: Set<string> | null,
  objectIdFieldsLookup: Set<string> | null,
  parentKey = '',
  parentOp?: string,
): unknown {
  if (value === null) return null;

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;

    if (isDateField(parentKey, dateFieldsLookup)) {
      if (parentOp && IN_LIKE_OPS.has(parentOp)) {
        return coerceDateScalar(value, timezone) ?? value;
      }
      if (PLAIN_DATE_RE.test(value)) {
        const { start, end } = plainDateToUtcRange(value, timezone);
        return { $gte: start, $lt: end };
      }
      return coerceDateScalar(value, timezone) ?? value;
    }

    // ObjectId coercion — applies to bare equality values ("?categoryId=...")
    // as well as values nested under comparison/membership operators
    // ("?categoryId[in]=...,..."), since a plain string never matches an
    // ObjectId-typed field in MongoDB (different BSON types). Gated on the
    // field heuristic/explicit list AND a strict 24-char hex shape so we
    // never misinterpret a coincidentally-24-char plain string field.
    if (
      isObjectIdField(parentKey, objectIdFieldsLookup) &&
      HEX24_RE.test(value) &&
      isValidObjectId(value)
    ) {
      return new Types.ObjectId(value);
    }

    // Numeric coercion for comparison/membership operators (eq/ne/gt/gte/lt/lte/in/nin).
    // Without this, a string like "50" under { $lte: "50" } never matches a
    // Number field in MongoDB, since comparison operators are type-sensitive.
    if (
      parentOp &&
      COERCIBLE_OPS.has(parentOp) &&
      value.trim() !== '' &&
      !isNaN(Number(value))
    ) {
      return Number(value);
    }

    return value;
  }

  if (typeof value !== 'object' || value instanceof Date) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const coerced = coerceAll(
        value[i],
        timezone,
        dateFieldsLookup,
        objectIdFieldsLookup,
        parentKey,
        parentOp,
      );
      if (coerced !== undefined) out.push(coerced);
    }
    return out;
  }

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const newKey = COERCIBLE_OPS.has(k) ? `$${k}` : k;
    const isOp = k.startsWith('$') || COERCIBLE_OPS.has(k);
    const childPath = isOp ? parentKey : parentKey ? `${parentKey}.${k}` : k;
    out[newKey] = coerceAll(
      src[k],
      timezone,
      dateFieldsLookup,
      objectIdFieldsLookup,
      childPath,
      isOp ? k : undefined,
    );
  }
  return out;
}

// ─── Operator validation ────────────────────────────────────────────────────────

/** Throws on any BANNED_OPERATORS key at any depth, and on any top-level $ key not in ALLOWED_TOP_LEVEL_OPS. */
function rejectDisallowedOperators(
  filter: Record<string, unknown>,
  depth = 0,
): void {
  for (const k in filter) {
    if (!Object.prototype.hasOwnProperty.call(filter, k)) continue;

    if (BANNED_OPERATORS.has(k)) {
      throw new QueryAggregateValidationError(
        `Disallowed operator in query: "${k}"`,
      );
    }
    if (depth === 0 && k.startsWith('$') && !ALLOWED_TOP_LEVEL_OPS.has(k)) {
      throw new QueryAggregateValidationError(
        `Disallowed top-level operator in query string: "${k}"`,
      );
    }

    const v = filter[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (isPlainObject(item)) rejectDisallowedOperators(item, depth + 1);
      }
    } else if (isPlainObject(v)) {
      rejectDisallowedOperators(v, depth + 1);
    }
  }
}

/** Scans a developer-authored pipeline stage for destructive stage types ($out/$merge). */
function rejectBannedStages(stage: unknown): void {
  if (Array.isArray(stage)) {
    stage.forEach(rejectBannedStages);
    return;
  }
  if (!isPlainObject(stage)) return;
  for (const k in stage) {
    if (BANNED_STAGE_OPERATORS.has(k)) {
      throw new QueryAggregateValidationError(
        `Disallowed pipeline stage: "${k}"`,
      );
    }
    rejectBannedStages(stage[k]);
  }
}

// ─── Filter builder ───────────────────────────────────────────────────────────

function buildFilter(
  raw: QueryParams,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
  timezone: string,
  dateFieldsLookup: Set<string> | null,
  objectIdFieldsLookup: Set<string> | null,
  onDrop?: (path: string, value: unknown) => void,
): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const k in raw) {
    if (Object.prototype.hasOwnProperty.call(raw, k) && !RESERVED_KEYS.has(k)) {
      stripped[k] = raw[k];
    }
  }

  const safe = sanitize(stripped, 0, '', onDrop) as Record<string, unknown>;
  const coerced = coerceAll(
    safe,
    timezone,
    dateFieldsLookup,
    objectIdFieldsLookup,
  ) as Record<string, unknown>;
  const allowed = enforceAllowlist(coerced, allowedLookup, canonicalMap);
  rejectDisallowedOperators(allowed);
  return allowed;
}

// ─── Sort parser ──────────────────────────────────────────────────────────────

function parseSort(
  sort: string,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
): Record<string, 1 | -1> {
  const out: Record<string, 1 | -1> = {};
  let count = 0;

  for (const token of sort.split(',')) {
    if (count >= MAX_SORT_FIELDS) break;

    const trimmed = token.trim();
    if (!trimmed || trimmed === '-') continue;

    const desc = trimmed.startsWith('-');
    const field = desc ? trimmed.slice(1).trim() : trimmed;
    if (!field) continue;

    if (allowedLookup.size > 0) {
      if (!isFieldAllowed(field, allowedLookup)) continue;
      out[canonicalMap.get(field.toLowerCase()) ?? field] = desc ? -1 : 1;
    } else {
      out[field] = desc ? -1 : 1;
    }
    count++;
  }

  return Object.keys(out).length > 0 ? out : { ...DEFAULT_SORT };
}

// ─── Projection ───────────────────────────────────────────────────────────────

function sanitizeProjectionString(
  projection: string,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
): string {
  if (allowedLookup.size === 0) return projection;

  return projection
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      const field = token.startsWith('-') ? token.slice(1) : token;
      return (
        field === '__v' ||
        field === '_id' ||
        isFieldAllowed(field, allowedLookup)
      );
    })
    .map((token) => {
      const isNeg = token.startsWith('-');
      const field = isNeg ? token.slice(1) : token;
      const canonical = canonicalMap.get(field.toLowerCase()) ?? field;
      return isNeg ? `-${canonical}` : canonical;
    })
    .join(' ');
}

function projectionStringToObject(projection: string): Record<string, 0 | 1> {
  const out: Record<string, 0 | 1> = {};
  for (const token of projection.split(/\s+/).filter(Boolean)) {
    if (token.startsWith('-')) out[token.slice(1)] = 0;
    else out[token] = 1;
  }
  return out;
}

// ─── QueryAggregate ─────────────────────────────────────────────────────────────

/**
 * Fluent aggregation-pipeline builder / paginator for Mongoose 8/9, with
 * timezone-aware date filtering.
 */
export class QueryAggregate<T> {
  private readonly model: Model<T>;
  private readonly qs: Readonly<QueryParams>;
  private readonly options: Required<
    Omit<QueryAggregateOptions, 'onSlowQuery' | 'onSanitizeDrop'>
  > &
    Pick<QueryAggregateOptions, 'onSlowQuery' | 'onSanitizeDrop'>;

  private _allowedLookup: Set<string> = new Set();
  private _canonicalMap: Map<string, string> = new Map();
  private _dateFieldsLookup: Set<string> | null = null;
  private _objectIdFieldsLookup: Set<string> | null = null;

  /** URL-derived filter and server conditions are kept separate so server
   * conditions (merged last) can never be overridden by URL params. */
  private _urlFilter: Record<string, unknown> = {};
  private _serverConditions: Record<string, unknown> = {};
  private _searchOr: Record<string, unknown>[] = [];

  private _sort: Record<string, 1 | -1> = { ...DEFAULT_SORT };
  private _projection: Record<string, 0 | 1> | null = null;
  private _defaultProjection: Record<string, 0 | 1> | null = null;

  /** $lookup/$unwind/addStage() stages, in call order, spliced in after the base $match. */
  private _stages: PipelineStage[] = [];

  private readonly _page: number;
  private readonly _limit: number;

  constructor(
    model: Model<T>,
    queryString: QueryParams,
    options: QueryAggregateOptions = {},
  ) {
    this.model = model;
    this.qs = Object.freeze({ ...queryString });
    this.options = {
      timezone: resolveTimezone(options.timezone),
      maxTimeMS: options.maxTimeMS ?? DEFAULT_MAX_TIME_MS,
      slowQueryThresholdMS:
        options.slowQueryThresholdMS ??
        options.maxTimeMS ??
        DEFAULT_MAX_TIME_MS,
      maxLimit: options.maxLimit ?? DEFAULT_MAX_LIMIT,
      allowDiskUse: options.allowDiskUse ?? false,
      weekStartsOn: options.weekStartsOn ?? 6,
      onSlowQuery: options.onSlowQuery,
      onSanitizeDrop: options.onSanitizeDrop,
    };
    this._page = parsePage(this.qs.page);
    this._limit = parseLimit(this.qs.limit, this.options.maxLimit);
  }

  /** The resolved (validated) timezone this instance is using. */
  get timezone(): string {
    return this.options.timezone;
  }

  // ── Configuration ─────────────────────────────────────────────────────────

  /** Fields the client may filter, sort, and project. Case-insensitive. Call before filter()/sort()/project(). */
  allowFields(fields: string[]): this {
    const { lookup, canonical } = buildAllowedStructures(new Set(fields));
    this._allowedLookup = lookup;
    this._canonicalMap = canonical;
    return this;
  }

  /** Explicit list of fields treated as dates for timezone-aware coercion. Falls back to a name heuristic (createdAt/updatedAt/...) when omitted. */
  dateFields(fields: string[]): this {
    this._dateFieldsLookup = new Set(fields.map((f) => f.toLowerCase()));
    return this;
  }

  /** Explicit list of fields treated as ObjectId refs for coercion (client-supplied hex strings -> Types.ObjectId). Falls back to a name heuristic (_id/*Id) when omitted. */
  objectIdFields(fields: string[]): this {
    this._objectIdFieldsLookup = new Set(fields.map((f) => f.toLowerCase()));
    return this;
  }

  // ── Builder methods ───────────────────────────────────────────────────────

  /** Parses URL query params (req.query) into a Mongoose filter. Only allowlisted fields pass through. */
  filter(): this {
    const parsed = buildFilter(
      this.qs,
      this._allowedLookup,
      this._canonicalMap,
      this.options.timezone,
      this._dateFieldsLookup,
      this._objectIdFieldsLookup,
      this.options.onSanitizeDrop,
    );
    Object.assign(this._urlFilter, parsed);
    return this;
  }

  /** Mandatory server-side conditions the client cannot override — merged into the final $match last. */
  where(conditions: Partial<Record<keyof T, unknown>>): this {
    const asRecord = conditions as Record<string, unknown>;
    rejectDisallowedOperators(asRecord);
    Object.assign(this._serverConditions, asRecord);
    return this;
  }

  /** Adds a hard, server-defined UTC date range (in this instance's timezone) on `field`. Not client-overridable. */
  range(field: string, preset: RangePreset): this {
    const { start, end } = this.resolveRangePreset(preset);
    this._serverConditions[field] = { $gte: start, $lt: end };
    return this;
  }

  // ── Custom range methods (additive — RangePreset/.range() above is
  // untouched; these cover custom day / custom range / custom N-days /
  // custom N-hours / custom hour-of-day window / custom absolute datetime
  // window use cases) ─────────────────────────────────────────────────────

  /** Hard server-side condition for a single arbitrary local calendar date (e.g. "2026-03-14"), in this instance's timezone. Not client-overridable. */
  rangeCustomDay(field: string, date: CustomDayInput): this {
    if (!PLAIN_DATE_RE.test(date)) {
      throw new QueryAggregateValidationError(
        `rangeCustomDay: "date" must be in YYYY-MM-DD format, got "${date}"`,
      );
    }
    const { start, end } = this.utcRangeForLocalDates(date, date);
    this._serverConditions[field] = { $gte: start, $lt: end };
    return this;
  }

  /** Hard server-side condition for an arbitrary inclusive local-date span (e.g. { from: "2026-01-01", to: "2026-01-31" }), in this instance's timezone. Not client-overridable. */
  rangeBetween(field: string, custom: CustomDateRangeInput): this {
    const { from, to } = custom;
    if (!PLAIN_DATE_RE.test(from) || !PLAIN_DATE_RE.test(to)) {
      throw new QueryAggregateValidationError(
        `rangeBetween: "from"/"to" must be in YYYY-MM-DD format, got "${from}" / "${to}"`,
      );
    }
    const { start, end } = this.utcRangeForLocalDates(from, to);
    this._serverConditions[field] = { $gte: start, $lt: end };
    return this;
  }

  /** Hard server-side condition for a rolling window of the last N whole calendar days (inclusive of today), in this instance's timezone. Not client-overridable. */
  rangeLastNDays(field: string, days: number): this {
    if (!Number.isInteger(days) || days < 1) {
      throw new QueryAggregateValidationError(
        `rangeLastNDays: "days" must be a positive integer, got ${days}`,
      );
    }
    const tz = this.options.timezone;
    const zonedNow = toZonedTime(new Date(), tz);
    const todayStr = format(zonedNow, 'yyyy-MM-dd');
    const fromStr = shiftLocalDateString(todayStr, -(days - 1));
    const { start, end } = this.utcRangeForLocalDates(fromStr, todayStr);
    this._serverConditions[field] = { $gte: start, $lt: end };
    return this;
  }

  /** Hard server-side condition for a rolling window of the last N hours, ending at the moment this is called (exact UTC instants — no calendar-date snapping). Not client-overridable. */
  rangeLastNHours(field: string, hours: number): this {
    if (!Number.isInteger(hours) || hours < 1) {
      throw new QueryAggregateValidationError(
        `rangeLastNHours: "hours" must be a positive integer, got ${hours}`,
      );
    }
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    this._serverConditions[field] = { $gte: start, $lt: end };
    return this;
  }

  /** Hard server-side condition for an explicit hour-of-day window on a given local date (e.g. 09:00–17:00 on "2026-03-14"), in this instance's timezone. `toHour` is exclusive; pass 24 for "through end of day". Not client-overridable. */
  rangeHours(field: string, custom: CustomHourRangeInput): this {
    const { date, fromHour, toHour } = custom;
    if (!PLAIN_DATE_RE.test(date)) {
      throw new QueryAggregateValidationError(
        `rangeHours: "date" must be in YYYY-MM-DD format, got "${date}"`,
      );
    }
    if (
      !Number.isInteger(fromHour) ||
      !Number.isInteger(toHour) ||
      fromHour < 0 ||
      fromHour > 24 ||
      toHour < 0 ||
      toHour > 24 ||
      toHour <= fromHour
    ) {
      throw new QueryAggregateValidationError(
        `rangeHours: "fromHour"/"toHour" must be integers 0–24 with toHour > fromHour, got ${fromHour} / ${toHour}`,
      );
    }
    const tz = this.options.timezone;
    const pad = (n: number) => String(n).padStart(2, '0');
    const start = fromZonedTime(`${date}T${pad(fromHour)}:00:00.000`, tz);
    const end =
      toHour === 24
        ? fromZonedTime(`${shiftLocalDateString(date, 1)}T00:00:00.000`, tz)
        : fromZonedTime(`${date}T${pad(toHour)}:00:00.000`, tz);
    this._serverConditions[field] = { $gte: start, $lt: end };
    return this;
  }

  /**
   * Hard server-side condition for an explicit absolute datetime window.
   * Accepts "YYYY-MM-DD" (local midnight), "YYYY-MM-DDTHH:mm:ss" (local
   * wall-clock), or an offset-bearing ISO string (absolute instant) for
   * both `from` and `to`. Not client-overridable.
   */
  rangeCustom(field: string, custom: CustomDateTimeRangeInput): this {
    const tz = this.options.timezone;
    const start = coerceDateScalar(custom.from, tz);
    const end = coerceDateScalar(custom.to, tz);
    if (!start || !end) {
      throw new QueryAggregateValidationError(
        `rangeCustom: could not parse "from"/"to" — got "${custom.from}" / "${custom.to}"`,
      );
    }
    if (end <= start) {
      throw new QueryAggregateValidationError(
        `rangeCustom: "to" (${custom.to}) must be after "from" (${custom.from})`,
      );
    }
    this._serverConditions[field] = { $gte: start, $lt: end };
    return this;
  }

  /** Case-insensitive full-text search across the given fields when ?q= is present. */
  globalSearch(fields: string[]): this {
    const raw = this.qs.q?.trim();
    if (!raw || raw.length > MAX_SEARCH_LENGTH || fields.length === 0)
      return this;

    const safeFields =
      this._allowedLookup.size > 0
        ? fields.filter((f) => isFieldAllowed(f, this._allowedLookup))
        : fields;
    if (safeFields.length === 0) return this;

    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    for (const field of safeFields) this._searchOr.push({ [field]: regex });
    return this;
  }

  /** Parses ?sort= (e.g. "-createdAt,name"). Fields not in allowFields() are dropped; falls back to DEFAULT_SORT. */
  sort(): this {
    if (this.qs.sort) {
      this._sort = parseSort(
        this.qs.sort,
        this._allowedLookup,
        this._canonicalMap,
      );
    }
    return this;
  }

  /**
   * Controls the $project stage. Accepts a space-separated string ("name status -_id")
   * or a raw { field: 0|1 } object. When ?fields= is present it's parsed and
   * filtered through the allowlist; if every requested field is blocked, falls
   * back to `defaultProjection` instead of silently selecting everything.
   */
  project(defaultProjection?: string | Record<string, 0 | 1>): this {
    if (defaultProjection) {
      this._defaultProjection =
        typeof defaultProjection === 'string'
          ? projectionStringToObject(defaultProjection)
          : defaultProjection;
    }

    if (this.qs.fields) {
      const raw = this.qs.fields
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
        .join(' ');
      const sanitized = sanitizeProjectionString(
        raw,
        this._allowedLookup,
        this._canonicalMap,
      );
      this._projection = sanitized
        ? projectionStringToObject(sanitized)
        : this._defaultProjection;
    } else {
      this._projection = this._defaultProjection;
    }
    return this;
  }

  /** Adds a $lookup (join) stage, optionally followed by $unwind when `single` is true. */
  lookup(opts: LookupOptions): this {
    const lookupStage: PipelineStage.Lookup = {
      $lookup: {
        from: opts.from,
        as: opts.as,
        ...(opts.pipeline ? { pipeline: opts.pipeline } : {}),
        ...(opts.localField ? { localField: opts.localField } : {}),
        ...(opts.foreignField ? { foreignField: opts.foreignField } : {}),
      },
    };
    this._stages.push(lookupStage);
    if (opts.single) {
      this._stages.push({
        $unwind: { path: `$${opts.as}`, preserveNullAndEmptyArrays: true },
      });
    }
    return this;
  }

  /** Escape hatch for any other developer-authored stage ($addFields, $group, post-join $match, ...). Blocks $out/$merge only — this path is for trusted, server-defined stages, not client input. */
  addStage(stage: PipelineStage): this {
    rejectBannedStages(stage);
    this._stages.push(stage);
    return this;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private resolveRangePreset(preset: RangePreset): { start: Date; end: Date } {
    const tz = this.options.timezone;
    const zonedNow = toZonedTime(new Date(), tz);
    const todayStr = format(zonedNow, 'yyyy-MM-dd');

    switch (preset) {
      case 'today':
        return this.utcRangeForLocalDates(todayStr, todayStr);
      case 'yesterday': {
        const y = shiftLocalDateString(todayStr, -1);
        return this.utcRangeForLocalDates(y, y);
      }
      case 'last7Days':
        return this.utcRangeForLocalDates(
          shiftLocalDateString(todayStr, -6),
          todayStr,
        );
      case 'last30Days':
        return this.utcRangeForLocalDates(
          shiftLocalDateString(todayStr, -29),
          todayStr,
        );
      case 'thisWeek': {
        const weekStartStr = format(
          startOfWeek(zonedNow, { weekStartsOn: this.options.weekStartsOn }),
          'yyyy-MM-dd',
        );
        return this.utcRangeForLocalDates(weekStartStr, todayStr);
      }
      case 'thisMonth': {
        const monthStartStr = format(startOfMonth(zonedNow), 'yyyy-MM-dd');
        return this.utcRangeForLocalDates(monthStartStr, todayStr);
      }
      default:
        throw new QueryAggregateValidationError(
          `Unknown range preset: "${preset}"`,
        );
    }
  }

  /** [start of fromStr, start of (toStr + 1 day)) in this instance's timezone — an inclusive local-date range. */
  private utcRangeForLocalDates(
    fromStr: string,
    toStr: string,
  ): { start: Date; end: Date } {
    const tz = this.options.timezone;
    const start = fromZonedTime(`${fromStr}T00:00:00.000`, tz);
    const end = fromZonedTime(
      `${shiftLocalDateString(toStr, 1)}T00:00:00.000`,
      tz,
    );
    return { start, end };
  }

  private buildMatchStage(): PipelineStage.Match | null {
    let base: Record<string, unknown>;
    const hasUrlFilter = Object.keys(this._urlFilter).length > 0;

    if (this._searchOr.length > 0) {
      base = hasUrlFilter
        ? { $and: [this._urlFilter, { $or: this._searchOr }] }
        : { $or: this._searchOr };
    } else {
      base = hasUrlFilter ? this._urlFilter : {};
    }

    const hasServer = Object.keys(this._serverConditions).length > 0;
    const finalFilter =
      Object.keys(base).length > 0 && hasServer
        ? { $and: [base, this._serverConditions] }
        : hasServer
          ? this._serverConditions
          : base;

    return Object.keys(finalFilter).length > 0 ? { $match: finalFilter } : null;
  }

  /** Match + lookups/custom stages only, no $project/$sort — shared by count()/distinct()/stats(), which don't need either. */
  private buildMatchAndStagesPipeline(): PipelineStage[] {
    const pipeline: PipelineStage[] = [];
    const matchStage = this.buildMatchStage();
    if (matchStage) pipeline.push(matchStage);
    pipeline.push(...this._stages);
    return pipeline;
  }

  /** Encodes a keyset cursor from a result row: the current sort field's value plus `_id` as a stable tiebreaker. */
  private encodeCursor(
    doc: Record<string, unknown>,
    sortField: string,
  ): string {
    const raw = doc[sortField];
    let v: unknown = raw;
    let t: 'date' | 'objectid' | 'other' = 'other';
    if (raw instanceof Date) {
      v = raw.toISOString();
      t = 'date';
    } else if (raw instanceof Types.ObjectId) {
      v = raw.toString();
      t = 'objectid';
    }
    const id = doc._id;
    return Buffer.from(JSON.stringify({ v, t, id: String(id) })).toString(
      'base64url',
    );
  }

  /** Decodes a cursor produced by encodeCursor(), restoring Date/ObjectId typing so comparisons stay type-correct. */
  private decodeCursor(cursor: string): { v: unknown; id: string } {
    let parsed: { v: unknown; t?: string; id: string };
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new QueryAggregateValidationError('paginateCursor: invalid cursor');
    }
    let v = parsed.v;
    if (parsed.t === 'date' && typeof v === 'string') v = new Date(v);
    if (
      parsed.t === 'objectid' &&
      typeof v === 'string' &&
      isValidObjectId(v)
    ) {
      v = new Types.ObjectId(v);
    }
    return { v, id: parsed.id };
  }

  /** Base pipeline shared by every execution path: match -> lookups/custom stages -> project -> sort. */
  private buildBasePipeline(): PipelineStage[] {
    const pipeline: PipelineStage[] = [];
    const matchStage = this.buildMatchStage();
    if (matchStage) pipeline.push(matchStage);
    pipeline.push(...this._stages);
    if (this._projection) pipeline.push({ $project: this._projection });
    pipeline.push({ $sort: this._sort });
    return pipeline;
  }

  private execAggregate<R = T>(pipeline: PipelineStage[]): Promise<R[]> {
    const agg = this.model.aggregate<R>(pipeline);
    if (this.options.maxTimeMS > 0)
      agg.option({ maxTimeMS: this.options.maxTimeMS });
    if (this.options.allowDiskUse) agg.allowDiskUse(true);
    return agg.exec();
  }

  private async wrapTimed<R>(
    fn: () => Promise<R>,
    page: number,
    limit: number,
    pipeline: PipelineStage[],
  ): Promise<R> {
    const { onSlowQuery, slowQueryThresholdMS, maxTimeMS } = this.options;
    if (!onSlowQuery) return fn();

    const start = Date.now();
    const result = await fn();
    const elapsedMs = Date.now() - start;

    if (elapsedMs >= (slowQueryThresholdMS ?? maxTimeMS)) {
      onSlowQuery({ elapsedMs, pipeline, sort: this._sort, page, limit });
    }
    return result;
  }

  // ── Terminal ───────────────────────────────────────────────────────────────

  /**
   * Executes the pipeline and returns a paginated result via $facet (single
   * round trip: data page + total count together). Pass a prior page-1
   * `total` as `cachedTotal` on later pages to skip the count entirely.
   *
   * Note: $facet buffers both branches in memory per query — for very large
   * collections with expensive pre-facet stages, consider passing
   * `cachedTotal` on subsequent pages, or run count/data as two calls.
   */
  async paginate(cachedTotal?: number): Promise<PaginatedResult<T>> {
    const page = this._page;
    const limit = this._limit;
    const basePipeline = this.buildBasePipeline();

    if (cachedTotal !== undefined) {
      const totalPages = Math.max(Math.ceil(cachedTotal / limit), 1);
      const safePage = page > totalPages ? 1 : page;
      const dataPipeline = [
        ...basePipeline,
        { $skip: (safePage - 1) * limit },
        { $limit: limit },
      ];
      const data = await this.wrapTimed(
        () => this.execAggregate(dataPipeline),
        safePage,
        limit,
        dataPipeline,
      );
      return {
        data,
        total: cachedTotal,
        page: safePage,
        totalPages,
        limit,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      };
    }

    const facetPipeline: PipelineStage[] = [
      ...basePipeline,
      {
        $facet: {
          data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          totalCount: [{ $count: 'count' }],
        },
      },
    ];

    const [facetResult] = await this.wrapTimed(
      () =>
        this.execAggregate<{ data: T[]; totalCount: { count: number }[] }>(
          facetPipeline,
        ),
      page,
      limit,
      facetPipeline,
    );

    const total = facetResult?.totalCount?.[0]?.count ?? 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    if (page > totalPages && page !== 1) {
      // Requested page doesn't exist for this filter — refetch page 1 rather
      // than returning an empty page silently.
      const fallbackPipeline = [
        ...basePipeline,
        { $skip: 0 },
        { $limit: limit },
      ];
      const data = await this.execAggregate(fallbackPipeline);
      return {
        data,
        total,
        page: 1,
        totalPages,
        limit,
        hasNextPage: 1 < totalPages,
        hasPrevPage: false,
      };
    }

    return {
      data: facetResult?.data ?? [],
      total,
      page,
      totalPages,
      limit,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }

  // ── Advanced terminal & utility methods (additive — paginate() above is
  // untouched) ─────────────────────────────────────────────────────────────

  /** Returns just the matching document count — cheaper than paginate() when you don't need the data page. Ignores $project/$sort. */
  async count(): Promise<number> {
    const pipeline = [
      ...this.buildMatchAndStagesPipeline(),
      { $count: 'count' } as PipelineStage,
    ];
    const [row] = await this.execAggregate<{ count: number }>(pipeline);
    return row?.count ?? 0;
  }

  /** Returns the distinct values of `field` for the current filter/where/range conditions. */
  async distinct<V = unknown>(field: string): Promise<V[]> {
    const pipeline = [
      ...this.buildMatchAndStagesPipeline(),
      { $group: { _id: `$${field}` } } as PipelineStage,
    ];
    const rows = await this.execAggregate<{ _id: V }>(pipeline);
    return rows.map((r) => r._id);
  }

  /**
   * Computes one or more aggregate metrics (sum/avg/min/max/count) over the
   * current filter/where/range conditions in a single round trip — handy for
   * dashboard totals ("revenue", "avgOrderValue", "orderCount", ...).
   * Ignores $project/$sort/pagination.
   */
  async stats(specs: StatSpec[]): Promise<Record<string, number>> {
    const group: Record<string, unknown> = { _id: null };
    for (const spec of specs) {
      if (spec.op === 'count') {
        group[spec.name] = { $sum: 1 };
      } else {
        if (!spec.field) {
          throw new QueryAggregateValidationError(
            `stats: metric "${spec.name}" needs a "field" for op "${spec.op}"`,
          );
        }
        group[spec.name] = { [`$${spec.op}`]: `$${spec.field}` };
      }
    }

    const pipeline = [
      ...this.buildMatchAndStagesPipeline(),
      { $group: group } as PipelineStage,
    ];
    const [row] = await this.execAggregate<Record<string, number>>(pipeline);

    const out: Record<string, number> = {};
    for (const spec of specs) out[spec.name] = row?.[spec.name] ?? 0;
    return out;
  }

  /**
   * Streams results as an async-iterable cursor instead of buffering the
   * whole page in memory — use for large exports (CSV generation, bulk
   * processing) with `for await (const doc of qa.stream())`. Ignores
   * page/limit; add your own $limit via .addStage() if you want a cap.
   */
  stream(): ReturnType<ReturnType<Model<T>['aggregate']>['cursor']> {
    const pipeline = this.buildBasePipeline();
    const agg = this.model.aggregate<T>(pipeline);
    if (this.options.maxTimeMS > 0)
      agg.option({ maxTimeMS: this.options.maxTimeMS });
    if (this.options.allowDiskUse) agg.allowDiskUse(true);
    return agg.cursor();
  }

  /**
   * Keyset ("seek") pagination — scales far better than .paginate()'s
   * $skip on deep pages of large collections, at the cost of not supporting
   * "jump to page N". Requires .sort() to have been called with exactly the
   * field you want to seek on (falls back to DEFAULT_SORT's `createdAt`
   * otherwise). Pass the previous page's `nextCursor` back in as `cursor`
   * to continue; a `hasNextPage: false` / `nextCursor: null` page is the end.
   */
  async paginateCursor(
    opts: CursorPaginateOptions = {},
  ): Promise<CursorPaginatedResult<T>> {
    const limit =
      opts.limit && opts.limit > 0
        ? Math.min(opts.limit, this.options.maxLimit)
        : this._limit;

    const [sortField, sortDir] = Object.entries(this._sort)[0] ?? [
      'createdAt',
      -1,
    ];

    const pipeline = this.buildMatchAndStagesPipeline();

    if (opts.cursor) {
      const { v, id } = this.decodeCursor(opts.cursor);
      const cmp = sortDir === -1 ? '$lt' : '$gt';
      const idValue = isValidObjectId(id) ? new Types.ObjectId(id) : id;
      pipeline.push({
        $match: {
          $or: [
            { [sortField]: { [cmp]: v } },
            { [sortField]: v, _id: { [cmp]: idValue } },
          ],
        },
      });
    }

    if (this._projection) pipeline.push({ $project: this._projection });
    pipeline.push({ $sort: { [sortField]: sortDir, _id: sortDir } });
    pipeline.push({ $limit: limit + 1 });

    const rows = await this.execAggregate<Record<string, unknown>>(pipeline);
    const hasNextPage = rows.length > limit;
    const data = (hasNextPage ? rows.slice(0, limit) : rows) as T[];
    const nextCursor = hasNextPage
      ? this.encodeCursor(
          data[data.length - 1] as unknown as Record<string, unknown>,
          sortField,
        )
      : null;

    return { data, limit, nextCursor, hasNextPage };
  }

  /**
   * Runs the built pipeline through Mongoose's .explain() for debugging
   * slow queries / verifying index usage. Never use in a hot request path —
   * this is a development/ops tool.
   */
  async explain(
    verbosity:
      | 'queryPlanner'
      | 'executionStats'
      | 'allPlansExecution' = 'queryPlanner',
  ): Promise<unknown> {
    const pipeline = this.buildBasePipeline();
    return this.model.aggregate(pipeline).explain(verbosity);
  }

  /** Convenience wrapper over addStage() for a computed $addFields entry, e.g. .computeField('margin', { $subtract: ['$price', '$cost'] }). */
  computeField(name: string, expression: unknown): this {
    return this.addStage({
      $addFields: { [name]: expression },
    } as PipelineStage);
  }

  /** Convenience server-side condition excluding soft-deleted docs (matches both `null` and a missing field, per MongoDB equality semantics). Not client-overridable. */
  excludeSoftDeleted(field = 'deletedAt'): this {
    this._serverConditions[field] = null;
    return this;
  }

  /** Applies .where(conditions) only when `condition` is truthy — avoids scattering if-statements around chained builder calls. */
  whereIf(
    condition: unknown,
    conditions: Partial<Record<keyof T, unknown>>,
  ): this {
    if (condition) this.where(conditions);
    return this;
  }

  /** Deep-copies the current builder state (filters, sort, projection, stages) into a new independent instance — handy for branching one shared base query into e.g. both .paginate() and .stats() without rebuilding it twice. */
  clone(): QueryAggregate<T> {
    const copy = new QueryAggregate<T>(this.model, this.qs, this.options);
    copy._allowedLookup = new Set(this._allowedLookup);
    copy._canonicalMap = new Map(this._canonicalMap);
    copy._dateFieldsLookup = this._dateFieldsLookup
      ? new Set(this._dateFieldsLookup)
      : null;
    copy._objectIdFieldsLookup = this._objectIdFieldsLookup
      ? new Set(this._objectIdFieldsLookup)
      : null;
    copy._urlFilter = { ...this._urlFilter };
    copy._serverConditions = { ...this._serverConditions };
    copy._searchOr = [...this._searchOr];
    copy._sort = { ...this._sort };
    copy._projection = this._projection ? { ...this._projection } : null;
    copy._defaultProjection = this._defaultProjection
      ? { ...this._defaultProjection }
      : null;
    copy._stages = [...this._stages];
    return copy;
  }

  /** Returns the fully-built pipeline without executing it — for logging, snapshot tests, or sanity-checking what will actually run. */
  debugPipeline(): PipelineStage[] {
    return this.buildBasePipeline();
  }
}

export default QueryAggregate;
