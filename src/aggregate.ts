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
 * Conditions (URL filter, search, where/range) that reference a joined field
 * (a `.lookup()` `as` alias that is not a real schema path, e.g. "category.name")
 * are automatically placed in a $match *after* the join; everything else stays
 * in the first $match so indexes can be used.
 *
 * ── Custom ranges ────────────────────────────────────────────────────────────
 * `.range(field, preset)` covers the fixed RangePreset values (today,
 * yesterday, last7Days, last30Days, thisWeek, thisMonth). For anything more
 * specific — a single arbitrary day, an arbitrary date span, a rolling
 * window of N days/hours, an explicit hour-of-day window, or an explicit
 * absolute datetime window — use the custom range methods below:
 *
 *   .rangeCustomDay(field, '2026-03-14')
 *   .rangeBetween(field, { from: '2026-01-01', to: '2026-01-31' })
 *   .rangeLastNDays(field, 14)
 *   .rangeLastNHours(field, 6)
 *   .rangeHours(field, { date: '2026-03-14', fromHour: 9, toHour: 17 })
 *   .rangeCustom(field, { from: '2026-03-14T09:00:00', to: '2026-03-15T00:00:00' })
 *
 * All of these behave like .range(): they set a hard, server-side condition
 * that the client cannot override via query params. Multiple server-side
 * conditions on the same field are AND-ed together (never silently overwritten).
 */

import { format, startOfMonth, startOfWeek } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { Model, PipelineStage, Types } from 'mongoose';

// ─── Constants ────────────────────────────────────────────────────────────────

const RESERVED_KEYS = new Set<string>(['page', 'sort', 'limit', 'fields', 'q']);
const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;
const MAX_PAGE = 1_000_000_000;
const MAX_NESTING_DEPTH = 5;
const MAX_SEARCH_LENGTH = 200;
const MAX_SORT_FIELDS = 5;
const MAX_CURSOR_LENGTH = 1024;
const DEFAULT_MAX_TIME_MS = 5_000;
const DEFAULT_TIMEZONE = 'Asia/Dhaka';

// Matches only when the date-word is the LAST path segment (e.g. "createdAt",
// "user.updatedAt") — used as a fallback heuristic when neither .dateFields()
// nor the model schema identifies the field type.
const DATE_FIELD_RE =
  /(^|\.)(createdAt|updatedAt|deletedAt|archivedAt|expiresAt|date|birthDate)$/i;
const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A string that already carries its own UTC offset ("Z" or "+06:00") is
// treated as an absolute instant rather than a local wall-clock time.
const HAS_OFFSET_RE = /([Zz]|[+-]\d{2}:?\d{2})$/;

// Matches only when the id-word is the LAST path segment (e.g. "_id",
// "categoryId", "basicInfo.brandId") — fallback heuristic when neither
// .objectIdFields() nor the model schema identifies the field type.
const OBJECTID_FIELD_RE = /(^|\.)(_id|[a-zA-Z0-9]*Id)$/;
// A 24-char hex string — the only shape trusted as "meant to be an ObjectId".
const HEX24_RE = /^[a-fA-F0-9]{24}$/;
// Plain decimal numbers only (no hex, exponent, Infinity, or leading zeros
// such as phone numbers "0171...").
const NUMERIC_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const METRIC_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DANGEROUS_KEYS = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

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
const IN_LIKE_OPS = new Set(['in', 'nin']);
const STAT_OPS = new Set(['sum', 'avg', 'min', 'max', 'count']);

const DEFAULT_SORT: Record<string, 1 | -1> = { createdAt: -1 };
// NOTE: `$not` is not a valid top-level query operator in MongoDB, so it is not allowed here.
const ALLOWED_TOP_LEVEL_OPS = new Set(['$and', '$or', '$nor']);
// Rejected anywhere inside client-supplied filter/search/populate-match input.
const BANNED_OPERATORS = new Set([
  '$where',
  '$expr',
  '$function',
  '$accumulator',
  '$map',
  '$reduce',
  '$filter',
  // Not valid inside aggregation $match — would fail at runtime.
  '$near',
  '$nearSphere',
]);
// Rejected in developer-authored pipeline stages added via addStage()/lookup()
// pipelines — these can mutate or drop data and have no place in a query builder.
const BANNED_STAGE_OPERATORS = new Set(['$out', '$merge']);

// ─── Public types ─────────────────────────────────────────────────────────────

export interface QueryParams {
  page?: unknown;
  limit?: unknown;
  sort?: unknown;
  fields?: unknown;
  q?: unknown;
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

/** Server-side conditions accepted by .where() / .whereIf(). */
export type WhereConditions<T> =
  | Partial<Record<keyof T, unknown>>
  | Record<string, unknown>;

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

// ─── Internal types ───────────────────────────────────────────────────────────

type SortDir = 1 | -1;
type SchemaKind = 'string' | 'number' | 'boolean' | 'date' | 'objectid';

interface ResolvedOptions {
  timezone: string;
  maxTimeMS: number;
  slowQueryThresholdMS: number;
  maxLimit: number;
  allowDiskUse: boolean;
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  onSlowQuery?: (info: SlowQueryInfo) => void;
  onSanitizeDrop?: (path: string, value: unknown) => void;
}

interface CoerceCtx {
  timezone: string;
  dateExplicit: Set<string> | null;
  oidExplicit: Set<string> | null;
  typeOf: (path: string) => SchemaKind | undefined;
}

interface SchemaTypeLike {
  instance?: string;
  embeddedSchemaType?: { instance?: string };
  caster?: { instance?: string };
}

interface TypedValue {
  t: 'date' | 'oid' | 'raw';
  v: string | number | boolean | null;
}

interface CursorPayload {
  f: string;
  d: SortDir;
  v: TypedValue;
  id: TypedValue;
}

const SCHEMA_KIND_MAP: Record<string, SchemaKind> = {
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
  Date: 'date',
  ObjectId: 'objectid',
  ObjectID: 'objectid',
};

// ─── Input parsing ────────────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function parsePage(raw: unknown): number {
  const n = parseInt(asString(raw) ?? '1', 10);
  return !Number.isSafeInteger(n) || n < 1 || n > MAX_PAGE ? 1 : n;
}

function parseLimit(raw: unknown, maxLimit = DEFAULT_MAX_LIMIT): number {
  const n = parseInt(asString(raw) ?? String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(n) || n < 1) return Math.min(DEFAULT_LIMIT, maxLimit);
  return Math.min(n, maxLimit);
}

const validTimezones = new Set<string>();

function resolveTimezone(tz: unknown): string {
  const candidate =
    typeof tz === 'string' && tz.trim() && tz.length <= 64
      ? tz.trim()
      : DEFAULT_TIMEZONE;
  if (validTimezones.has(candidate)) return candidate;
  try {
    // Throws RangeError on an invalid IANA zone — cheapest available validator.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    validTimezones.add(candidate);
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

/** True only for a real calendar date in strict "YYYY-MM-DD" form (rejects "2026-02-31"). */
function isRealPlainDate(s: string): boolean {
  if (!PLAIN_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Shifts a "YYYY-MM-DD" string by N calendar days (pure UTC date math — DST-proof). */
function shiftLocalDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
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

/** Parses a single date/datetime string to a scalar UTC Date. */
function coerceDateScalar(value: string, timezone: string): Date | undefined {
  let parsed: Date;
  if (PLAIN_DATE_RE.test(value)) {
    if (!isRealPlainDate(value)) return undefined;
    parsed = fromZonedTime(`${value}T00:00:00.000`, timezone);
  } else if (HAS_OFFSET_RE.test(value)) {
    parsed = new Date(value);
  } else {
    parsed = fromZonedTime(value, timezone);
  }
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

function explicitHas(path: string, explicit: Set<string> | null): boolean {
  if (!explicit || explicit.size === 0 || !path) return false;
  const lc = path.toLowerCase();
  if (explicit.has(lc)) return true;
  const lastSeg = lc.split('.').pop() ?? lc;
  return explicit.has(lastSeg);
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v instanceof Date) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

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

  if (isPlainObject(value)) {
    const src = value;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      const childPath = path ? `${path}.${k}` : k;
      const s = sanitize(src[k], depth + 1, childPath, onDrop);
      if (s !== undefined) out[k] = s;
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

/** Strips any non-operator key not present in the allowlist; recurses into logical operators. */
function enforceAllowlist(
  filter: Record<string, unknown>,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
): Record<string, unknown> {
  if (allowedLookup.size === 0) return filter;

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(filter)) {
    const v = filter[k];

    if (k.startsWith('$')) {
      if (Array.isArray(v)) {
        // Clauses that were fully stripped are dropped (an empty clause would
        // otherwise match everything inside $or).
        const items = v
          .map((item) =>
            isPlainObject(item)
              ? enforceAllowlist(item, allowedLookup, canonicalMap)
              : item,
          )
          .filter(
            (item) => !(isPlainObject(item) && Object.keys(item).length === 0),
          );
        if (items.length > 0) out[k] = items;
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

// ─── Fused coercion pass (timezone + schema aware) ─────────────────────────────

function parseNumeric(value: string): number | undefined {
  if (!NUMERIC_RE.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) return undefined;
  return n;
}

function resolveKind(
  path: string,
  ctx: CoerceCtx,
): { kind?: SchemaKind; strict: boolean } {
  if (!path) return { strict: false };
  if (explicitHas(path, ctx.dateExplicit))
    return { kind: 'date', strict: true };
  if (explicitHas(path, ctx.oidExplicit))
    return { kind: 'objectid', strict: true };

  const st = ctx.typeOf(path);
  if (st) return { kind: st, strict: true };

  if (
    !(ctx.dateExplicit && ctx.dateExplicit.size > 0) &&
    DATE_FIELD_RE.test(path)
  )
    return { kind: 'date', strict: false };
  if (
    !(ctx.oidExplicit && ctx.oidExplicit.size > 0) &&
    OBJECTID_FIELD_RE.test(path)
  )
    return { kind: 'objectid', strict: false };
  return { strict: false };
}

function coerceDateValue(
  value: string,
  op: string | undefined,
  timezone: string,
): unknown {
  if (op && IN_LIKE_OPS.has(op)) {
    return coerceDateScalar(value, timezone) ?? value;
  }
  if (isRealPlainDate(value)) {
    const { start, end } = plainDateToUtcRange(value, timezone);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return value;
    switch (op) {
      case undefined:
        return { $gte: start, $lt: end };
      case 'gt':
        // "after the whole day" -> $gt (end - 1ms), so a doc stamped exactly at
        // next-day 00:00:00.000 is included (returning `end` would drop it).
        return new Date(end.getTime() - 1);
      case 'lte':
        return new Date(end.getTime() - 1);
      default: // gte / lt / eq / ne (eq/ne are normally intercepted earlier)
        return start;
    }
  }
  return coerceDateScalar(value, timezone) ?? value;
}

function coerceString(
  value: string,
  path: string,
  op: string | undefined,
  ctx: CoerceCtx,
): unknown {
  const { kind, strict } = resolveKind(path, ctx);

  if (kind === 'string') return value;
  if (kind === 'date') return coerceDateValue(value, op, ctx.timezone);
  if (kind === 'objectid') {
    if (HEX24_RE.test(value)) return new Types.ObjectId(value);
    if (strict) return value;
  } else if (kind === 'number') {
    return parseNumeric(value) ?? value;
  } else if (kind === 'boolean') {
    return value === 'true' ? true : value === 'false' ? false : value;
  }

  // Unknown field type (e.g. joined/computed field) — conservative heuristics.
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (op && COERCIBLE_OPS.has(op)) {
    const n = parseNumeric(value);
    if (n !== undefined) return n;
  }
  return value;
}

/**
 * `inFilter` is true at the root of a filter and inside logical operators
 * ($and/$or/$nor), where keys are field names; false inside a field's value,
 * where keys are comparison operators or sub-paths.
 */
function coerceAll(
  value: unknown,
  ctx: CoerceCtx,
  path = '',
  op?: string,
  inFilter = true,
): unknown {
  if (value === null) return null;

  if (typeof value === 'string') {
    return path ? coerceString(value, path, op, ctx) : value;
  }

  if (typeof value !== 'object' || value instanceof Date) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const coerced = coerceAll(item, ctx, path, op, inFilter);
      if (coerced !== undefined) out.push(coerced);
    }
    return out;
  }

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const k of Object.keys(src)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    const v = src[k];

    if (inFilter) {
      out[k] = k.startsWith('$')
        ? coerceAll(v, ctx, '', undefined, true)
        : coerceAll(v, ctx, k, undefined, false);
      continue;
    }

    const isOp = k.startsWith('$') || COERCIBLE_OPS.has(k);
    if (!isOp) {
      out[k] = coerceAll(v, ctx, path ? `${path}.${k}` : k, undefined, false);
      continue;
    }

    const bare = k.startsWith('$') ? k.slice(1) : k;
    const outKey = k.startsWith('$') ? k : `$${k}`;

    // ?field[eq]=2026-09-01 / [ne]= on a date field -> whole-day range semantics.
    if (
      (bare === 'eq' || bare === 'ne') &&
      typeof v === 'string' &&
      isRealPlainDate(v) &&
      resolveKind(path, ctx).kind === 'date'
    ) {
      const { start, end } = plainDateToUtcRange(v, ctx.timezone);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        if (bare === 'eq') {
          out.$gte = start;
          out.$lt = end;
        } else {
          out.$not = { $gte: start, $lt: end };
        }
        continue;
      }
    }

    // ?field[in]=a,b,c -> ['a','b','c']
    const child =
      IN_LIKE_OPS.has(bare) && typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v;

    out[outKey] = coerceAll(child, ctx, path, bare, false);
  }
  return out;
}

// ─── Operator validation ────────────────────────────────────────────────────────

/**
 * Throws on any BANNED_OPERATORS key at any depth. When `topLevelCheck` is true
 * (client input) it also throws on any top-level $ key not in ALLOWED_TOP_LEVEL_OPS
 * and requires logical operators to hold a non-empty array of plain objects.
 */
function rejectDisallowedOperators(
  filter: Record<string, unknown>,
  depth = 0,
  topLevelCheck = true,
): void {
  for (const k of Object.keys(filter)) {
    if (BANNED_OPERATORS.has(k)) {
      throw new QueryAggregateValidationError(
        `Disallowed operator in query: "${k}"`,
      );
    }
    const v = filter[k];

    if (topLevelCheck && depth === 0 && k.startsWith('$')) {
      if (!ALLOWED_TOP_LEVEL_OPS.has(k)) {
        throw new QueryAggregateValidationError(
          `Disallowed top-level operator in query string: "${k}"`,
        );
      }
      if (!Array.isArray(v) || v.length === 0 || !v.every(isPlainObject)) {
        throw new QueryAggregateValidationError(
          `Operator "${k}" requires a non-empty array of conditions`,
        );
      }
    }

    if (Array.isArray(v)) {
      for (const item of v) {
        if (isPlainObject(item))
          rejectDisallowedOperators(item, depth + 1, topLevelCheck);
      }
    } else if (isPlainObject(v)) {
      rejectDisallowedOperators(v, depth + 1, topLevelCheck);
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
  for (const k of Object.keys(stage)) {
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
  ctx: CoerceCtx,
  onDrop?: (path: string, value: unknown) => void,
): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) {
    if (!RESERVED_KEYS.has(k) && !DANGEROUS_KEYS.has(k)) stripped[k] = raw[k];
  }

  const safe = sanitize(stripped, 0, '', onDrop) as Record<string, unknown>;
  const coerced = coerceAll(safe, ctx) as Record<string, unknown>;
  const allowed = enforceAllowlist(coerced, allowedLookup, canonicalMap);
  rejectDisallowedOperators(allowed);
  return allowed;
}

// ─── Sort parser ──────────────────────────────────────────────────────────────

function parseSort(
  sort: string,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
): Record<string, SortDir> {
  const out: Record<string, SortDir> = {};
  let count = 0;

  for (const token of sort.split(',')) {
    if (count >= MAX_SORT_FIELDS) break;

    const trimmed = token.trim();
    if (!trimmed || trimmed === '-') continue;

    const desc = trimmed.startsWith('-');
    const field = desc ? trimmed.slice(1).trim() : trimmed;
    if (!field || field.startsWith('$') || DANGEROUS_KEYS.has(field)) continue;

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

/**
 * Converts "a b -c" to { a: 1, b: 1, c: 0 }. Tokens with `$`/empty names are
 * ignored. MongoDB forbids mixing inclusion and exclusion (other than `_id`),
 * so when both appear the inclusion fields win and exclusions (except `_id`)
 * are dropped.
 */
function projectionStringToObject(projection: string): Record<string, 0 | 1> {
  const inc: Record<string, 0 | 1> = {};
  const exc: Record<string, 0 | 1> = {};
  for (const token of projection.split(/\s+/).filter(Boolean)) {
    const neg = token.startsWith('-');
    const field = neg ? token.slice(1) : token;
    if (!field || field.includes('$') || DANGEROUS_KEYS.has(field)) continue;
    if (neg) exc[field] = 0;
    else inc[field] = 1;
  }
  return normalizeProjection(inc, exc);
}

function normalizeProjection(
  inc: Record<string, 0 | 1>,
  exc: Record<string, 0 | 1>,
): Record<string, 0 | 1> {
  if (Object.keys(inc).length === 0) return exc;
  const out = { ...inc };
  if (exc._id === 0) out._id = 0;
  return out;
}

function normalizeProjectionObject(
  p: Record<string, 0 | 1>,
): Record<string, 0 | 1> {
  const inc: Record<string, 0 | 1> = {};
  const exc: Record<string, 0 | 1> = {};
  for (const k of Object.keys(p)) {
    if (!k || k.includes('$') || DANGEROUS_KEYS.has(k)) continue;
    if (p[k] === 0) exc[k] = 0;
    else inc[k] = 1;
  }
  const hasIncNonId = Object.keys(inc).some((k) => k !== '_id');
  if (!hasIncNonId) {
    // Pure exclusion (an `_id: 1` alone is just the default).
    delete inc._id;
    return Object.keys(inc).length === 0 && Object.keys(exc).length === 0
      ? {}
      : exc;
  }
  return normalizeProjection(inc, exc);
}

/**
 * Applies a client-requested exclusion-only projection ("-name") ON TOP of the
 * developer's default projection instead of replacing it. Without this, a
 * client sending ?fields=-name would turn the projection into { name: 0 },
 * which returns every other field — including fields that are not allowlisted
 * and fields the default projection deliberately hid.
 */
function applyClientExclusions(
  clientExc: Record<string, 0 | 1>,
  defaultProj: Record<string, 0 | 1> | null,
): Record<string, 0 | 1> {
  if (!defaultProj) return clientExc;

  const defaultIsInclusion = Object.keys(defaultProj).some(
    (k) => k !== '_id' && defaultProj[k] === 1,
  );

  if (!defaultIsInclusion) {
    // Default is itself exclusion-only: union of both exclusion sets.
    return { ...defaultProj, ...clientExc };
  }

  const out: Record<string, 0 | 1> = { ...defaultProj };
  for (const ex of Object.keys(clientExc)) {
    if (ex === '_id') {
      out._id = 0;
      continue;
    }
    for (const k of Object.keys(out)) {
      if (k === ex || k.startsWith(`${ex}.`)) delete out[k];
    }
  }
  // If nothing is left to include, never degrade into an exclusion-only
  // projection (that would return every field) — keep the default instead.
  const stillInclusion = Object.keys(out).some(
    (k) => k !== '_id' && out[k] === 1,
  );
  return stillInclusion ? out : { ...defaultProj };
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Deletes a dotted path and removes parent objects left empty by the deletion. */
function deletePath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  const parents: Record<string, unknown>[] = [];
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (!isPlainObject(next)) return;
    parents.push(cur);
    cur = next;
  }
  delete cur[parts[parts.length - 1]];
  for (let i = parts.length - 2; i >= 0; i--) {
    if (Object.keys(cur).length !== 0) break;
    const parent = parents[i];
    delete parent[parts[i]];
    cur = parent;
  }
}

/** Converts 24-hex strings to ObjectIds (recursing through arrays / operator objects). */
function castObjectIds(value: unknown): unknown {
  if (typeof value === 'string')
    return HEX24_RE.test(value) ? new Types.ObjectId(value) : value;
  if (Array.isArray(value)) return value.map(castObjectIds);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) out[k] = castObjectIds(value[k]);
    return out;
  }
  return value;
}

function assertFieldPath(field: string, label: string): void {
  if (typeof field !== 'string' || !FIELD_PATH_RE.test(field)) {
    throw new QueryAggregateValidationError(
      `${label}: invalid field path "${String(field)}"`,
    );
  }
}

function encodeTyped(raw: unknown): TypedValue {
  if (raw === undefined || raw === null) return { t: 'raw', v: null };
  if (raw instanceof Date) {
    return isNaN(raw.getTime())
      ? { t: 'raw', v: null }
      : { t: 'date', v: raw.toISOString() };
  }
  if (raw instanceof Types.ObjectId) return { t: 'oid', v: raw.toHexString() };
  if (
    typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'boolean'
  ) {
    return { t: 'raw', v: raw };
  }
  throw new QueryAggregateValidationError(
    'paginateCursor: the sort field must hold a scalar value (string, number, boolean, Date or ObjectId)',
  );
}

function decodeTyped(x: unknown): unknown {
  const bad = () =>
    new QueryAggregateValidationError('paginateCursor: invalid cursor');
  if (!isPlainObject(x)) throw bad();
  const { t, v } = x as { t?: unknown; v?: unknown };
  if (t === 'date') {
    if (typeof v !== 'string') throw bad();
    const d = new Date(v);
    if (isNaN(d.getTime())) throw bad();
    return d;
  }
  if (t === 'oid') {
    if (typeof v !== 'string' || !HEX24_RE.test(v)) throw bad();
    return new Types.ObjectId(v);
  }
  if (t === 'raw') {
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      return v;
    }
  }
  throw bad();
}

// ─── QueryAggregate ─────────────────────────────────────────────────────────────

/**
 * Fluent aggregation-pipeline builder / paginator for Mongoose 8/9, with
 * timezone-aware date filtering.
 */
export class QueryAggregate<T> {
  private readonly model: Model<T>;
  private readonly qs: Readonly<QueryParams>;
  private readonly options: ResolvedOptions;

  private _allowedLookup: Set<string> = new Set();
  private _canonicalMap: Map<string, string> = new Map();
  private _dateFieldsLookup: Set<string> | null = null;
  private _objectIdFieldsLookup: Set<string> | null = null;

  /** URL-derived filter and server conditions are kept separate so server
   * conditions can never be overridden by URL params. Server conditions are a
   * list (AND-ed together) so repeated conditions on one field never overwrite
   * each other. */
  private _urlFilter: Record<string, unknown> = {};
  private _serverConditions: Record<string, unknown>[] = [];
  private _searchOr: Record<string, unknown>[] = [];

  private _sort: Record<string, SortDir> = { ...DEFAULT_SORT };
  private _projection: Record<string, 0 | 1> | null = null;
  private _defaultProjection: Record<string, 0 | 1> | null = null;

  /** $lookup/$unwind/addStage() stages, in call order, spliced in after the base $match. */
  private _stages: PipelineStage[] = [];
  /** Root names of `as` aliases created by lookups; conditions on them run post-join. */
  private _joinAliases: Set<string> = new Set();
  /** Index in `_stages` right after the last $lookup — where the post-join $match goes. */
  private _postJoinIndex = 0;

  private _kindCache: Map<string, SchemaKind | undefined> = new Map();
  private _pathExistsCache: Map<string, boolean> = new Map();

  private readonly _page: number;
  private readonly _limit: number;

  constructor(
    model: Model<T>,
    queryString: QueryParams,
    options: QueryAggregateOptions = {},
  ) {
    this.model = model;
    this.qs = Object.freeze({ ...queryString });

    const maxLimit =
      typeof options.maxLimit === 'number' &&
      Number.isFinite(options.maxLimit) &&
      options.maxLimit >= 1
        ? Math.floor(options.maxLimit)
        : DEFAULT_MAX_LIMIT;
    const maxTimeMS =
      typeof options.maxTimeMS === 'number' &&
      Number.isFinite(options.maxTimeMS) &&
      options.maxTimeMS >= 0
        ? options.maxTimeMS
        : DEFAULT_MAX_TIME_MS;
    const weekStartsOn =
      typeof options.weekStartsOn === 'number' &&
      Number.isInteger(options.weekStartsOn) &&
      options.weekStartsOn >= 0 &&
      options.weekStartsOn <= 6
        ? options.weekStartsOn
        : 6;

    this.options = {
      timezone: resolveTimezone(options.timezone),
      maxTimeMS,
      slowQueryThresholdMS:
        options.slowQueryThresholdMS ??
        (maxTimeMS > 0 ? maxTimeMS : DEFAULT_MAX_TIME_MS),
      maxLimit,
      allowDiskUse: options.allowDiskUse ?? false,
      weekStartsOn,
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

  // ── Schema helpers ────────────────────────────────────────────────────────

  private schemaType(path: string): SchemaTypeLike | undefined {
    try {
      const schema = (
        this.model as unknown as {
          schema?: { path(p: string): SchemaTypeLike | undefined };
        }
      ).schema;
      return schema?.path(path) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Field type from the model schema, when known (undefined for joined/computed/unknown paths). */
  private schemaKind(path: string): SchemaKind | undefined {
    if (this._kindCache.has(path)) return this._kindCache.get(path);
    const st = this.schemaType(path);
    let instance = st?.instance;
    if (instance === 'Array') {
      instance = st?.embeddedSchemaType?.instance ?? st?.caster?.instance;
    }
    const kind = instance ? SCHEMA_KIND_MAP[instance] : undefined;
    this._kindCache.set(path, kind);
    return kind;
  }

  private schemaHasPath(path: string): boolean {
    const cached = this._pathExistsCache.get(path);
    if (cached !== undefined) return cached;
    const exists = this.schemaType(path) !== undefined;
    this._pathExistsCache.set(path, exists);
    return exists;
  }

  private coerceCtx(): CoerceCtx {
    return {
      timezone: this.options.timezone,
      dateExplicit: this._dateFieldsLookup,
      oidExplicit: this._objectIdFieldsLookup,
      typeOf: (p) => this.schemaKind(p),
    };
  }

  // ── Configuration ─────────────────────────────────────────────────────────

  /** Fields the client may filter, sort, and project. Case-insensitive. Call before filter()/sort()/project(). */
  allowFields(fields: string[]): this {
    const { lookup, canonical } = buildAllowedStructures(new Set(fields));
    this._allowedLookup = lookup;
    this._canonicalMap = canonical;
    return this;
  }

  /** Explicit list of fields treated as dates for timezone-aware coercion. Falls back to the model schema / a name heuristic (createdAt/updatedAt/...) when omitted. */
  dateFields(fields: string[]): this {
    this._dateFieldsLookup = new Set(fields.map((f) => f.toLowerCase()));
    return this;
  }

  /** Explicit list of fields treated as ObjectId refs for coercion (client-supplied hex strings -> Types.ObjectId). Falls back to the model schema / a name heuristic (_id/*Id) when omitted. */
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
      this.coerceCtx(),
      this.options.onSanitizeDrop,
    );
    Object.assign(this._urlFilter, parsed);
    return this;
  }

  /**
   * Mandatory server-side conditions the client cannot override. Repeated
   * calls (and range*() calls) are AND-ed together, never overwritten.
   * Strings that are 24-hex ObjectIds on ObjectId schema paths are cast
   * automatically (aggregate() does not auto-cast like find() does).
   */
  where(conditions: WhereConditions<T>): this {
    const asRecord = conditions as Record<string, unknown>;
    for (const k of Object.keys(asRecord)) {
      if (asRecord[k] === undefined) {
        throw new QueryAggregateValidationError(
          `where: condition for "${k}" is undefined`,
        );
      }
    }
    rejectDisallowedOperators(asRecord, 0, false);
    if (Object.keys(asRecord).length === 0) return this;
    this._serverConditions.push(this.castServerConditions(asRecord));
    return this;
  }

  /** Adds a hard, server-defined UTC date range (in this instance's timezone) on `field`. Not client-overridable. */
  range(field: string, preset: RangePreset): this {
    const { start, end } = this.resolveRangePreset(preset);
    this.pushRange(field, start, end);
    return this;
  }

  // ── Custom range methods ──────────────────────────────────────────────────

  /** Hard server-side condition for a single arbitrary local calendar date (e.g. "2026-03-14"), in this instance's timezone. Not client-overridable. */
  rangeCustomDay(field: string, date: CustomDayInput): this {
    if (!isRealPlainDate(date)) {
      throw new QueryAggregateValidationError(
        `rangeCustomDay: "date" must be a valid date in YYYY-MM-DD format, got "${date}"`,
      );
    }
    const { start, end } = this.utcRangeForLocalDates(date, date);
    this.pushRange(field, start, end);
    return this;
  }

  /** Hard server-side condition for an arbitrary inclusive local-date span (e.g. { from: "2026-01-01", to: "2026-01-31" }), in this instance's timezone. Not client-overridable. */
  rangeBetween(field: string, custom: CustomDateRangeInput): this {
    const { from, to } = custom;
    if (!isRealPlainDate(from) || !isRealPlainDate(to)) {
      throw new QueryAggregateValidationError(
        `rangeBetween: "from"/"to" must be valid dates in YYYY-MM-DD format, got "${from}" / "${to}"`,
      );
    }
    if (from > to) {
      throw new QueryAggregateValidationError(
        `rangeBetween: "from" (${from}) must not be after "to" (${to})`,
      );
    }
    const { start, end } = this.utcRangeForLocalDates(from, to);
    this.pushRange(field, start, end);
    return this;
  }

  /** Hard server-side condition for a rolling window of the last N whole calendar days (inclusive of today), in this instance's timezone. Not client-overridable. */
  rangeLastNDays(field: string, days: number): this {
    if (!Number.isInteger(days) || days < 1) {
      throw new QueryAggregateValidationError(
        `rangeLastNDays: "days" must be a positive integer, got ${days}`,
      );
    }
    const todayStr = this.todayLocal();
    const fromStr = shiftLocalDateString(todayStr, -(days - 1));
    const { start, end } = this.utcRangeForLocalDates(fromStr, todayStr);
    this.pushRange(field, start, end);
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
    if (isNaN(start.getTime())) {
      throw new QueryAggregateValidationError(
        `rangeLastNHours: "hours" is too large, got ${hours}`,
      );
    }
    this.pushRange(field, start, end);
    return this;
  }

  /** Hard server-side condition for an explicit hour-of-day window on a given local date (e.g. 09:00–17:00 on "2026-03-14"), in this instance's timezone. `toHour` is exclusive; pass 24 for "through end of day". Not client-overridable. */
  rangeHours(field: string, custom: CustomHourRangeInput): this {
    const { date, fromHour, toHour } = custom;
    if (!isRealPlainDate(date)) {
      throw new QueryAggregateValidationError(
        `rangeHours: "date" must be a valid date in YYYY-MM-DD format, got "${date}"`,
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
    const start =
      fromHour === 24
        ? fromZonedTime(`${shiftLocalDateString(date, 1)}T00:00:00.000`, tz)
        : fromZonedTime(`${date}T${pad(fromHour)}:00:00.000`, tz);
    const end =
      toHour === 24
        ? fromZonedTime(`${shiftLocalDateString(date, 1)}T00:00:00.000`, tz)
        : fromZonedTime(`${date}T${pad(toHour)}:00:00.000`, tz);
    this.pushRange(field, start, end);
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
    this.pushRange(field, start, end);
    return this;
  }

  /** Case-insensitive full-text search across the given fields when ?q= is present. */
  globalSearch(fields: string[]): this {
    const raw = asString(this.qs.q)?.trim();
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
    const raw = asString(this.qs.sort);
    if (raw) {
      this._sort = parseSort(raw, this._allowedLookup, this._canonicalMap);
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
      const obj =
        typeof defaultProjection === 'string'
          ? projectionStringToObject(defaultProjection)
          : normalizeProjectionObject(defaultProjection);
      this._defaultProjection = Object.keys(obj).length > 0 ? obj : null;
    }

    const fieldsRaw = asString(this.qs.fields);
    if (fieldsRaw) {
      const raw = fieldsRaw
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
        .join(' ');
      const sanitized = sanitizeProjectionString(
        raw,
        this._allowedLookup,
        this._canonicalMap,
      );
      const obj = sanitized ? projectionStringToObject(sanitized) : {};
      const keys = Object.keys(obj);
      const isExclusionOnly =
        keys.length > 0 && keys.every((k) => obj[k] === 0);
      this._projection =
        keys.length === 0
          ? this._defaultProjection
          : isExclusionOnly
            ? applyClientExclusions(obj, this._defaultProjection)
            : obj;
    } else {
      this._projection = this._defaultProjection;
    }
    return this;
  }

  /** Adds a $lookup (join) stage, optionally followed by $unwind when `single` is true. */
  lookup(opts: LookupOptions): this {
    const hasLocalForeign = Boolean(opts.localField && opts.foreignField);
    if (!hasLocalForeign && !opts.pipeline) {
      throw new QueryAggregateValidationError(
        'lookup: provide either localField + foreignField or a pipeline',
      );
    }
    if (opts.pipeline) rejectBannedStages(opts.pipeline);

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
    this.registerJoin(opts.as);
    return this;
  }

  /** Escape hatch for any other developer-authored stage ($addFields, $group, post-join $match, ...). Blocks $out/$merge only — this path is for trusted, server-defined stages, not client input. */
  addStage(stage: PipelineStage): this {
    rejectBannedStages(stage);
    this._stages.push(stage);
    if ('$lookup' in stage) {
      const as = (stage as PipelineStage.Lookup).$lookup.as;
      if (typeof as === 'string') this.registerJoin(as);
    }
    return this;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private registerJoin(as: string): void {
    this._joinAliases.add(as.split('.')[0]);
    this._postJoinIndex = this._stages.length;
  }

  private pushRange(field: string, start: Date, end: Date): void {
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new QueryAggregateValidationError(
        `Invalid date range for "${field}"`,
      );
    }
    this._serverConditions.push({ [field]: { $gte: start, $lt: end } });
  }

  private todayLocal(): string {
    return format(toZonedTime(new Date(), this.options.timezone), 'yyyy-MM-dd');
  }

  private castServerConditions(
    cond: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(cond)) {
      const v = cond[k];
      if (k.startsWith('$')) {
        out[k] = Array.isArray(v)
          ? v.map((i) => (isPlainObject(i) ? this.castServerConditions(i) : i))
          : v;
        continue;
      }
      out[k] = this.schemaKind(k) === 'objectid' ? castObjectIds(v) : v;
    }
    return out;
  }

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
          `Unknown range preset: "${String(preset)}"`,
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

  /** Effective sort: the requested sort plus `_id` as a stable tiebreaker (prevents duplicate/missing rows across pages). */
  private effectiveSort(): Record<string, SortDir> {
    if ('_id' in this._sort) return { ...this._sort };
    const dir: SortDir = Object.values(this._sort)[0] ?? -1;
    return { ...this._sort, _id: dir };
  }

  // A key is "joined" when it lives under a lookup alias and is not a real schema path.
  private isJoinedKey(key: string): boolean {
    if (this._joinAliases.size === 0) return false;
    if (this.schemaHasPath(key)) return false;
    return this._joinAliases.has(key.split('.')[0]);
  }

  private referencesJoined(key: string, value: unknown): boolean {
    if (!key.startsWith('$')) return this.isJoinedKey(key);
    const items = Array.isArray(value) ? value : [value];
    return items.some(
      (it) =>
        isPlainObject(it) &&
        Object.keys(it).some((k) => this.referencesJoined(k, it[k])),
    );
  }

  private splitConditions(cond: Record<string, unknown>): {
    pre: Record<string, unknown>;
    post: Record<string, unknown>;
  } {
    const pre: Record<string, unknown> = {};
    const post: Record<string, unknown> = {};
    for (const k of Object.keys(cond)) {
      (this.referencesJoined(k, cond[k]) ? post : pre)[k] = cond[k];
    }
    return { pre, post };
  }

  /** Builds the pre-join $match (index-friendly) and the post-join $match (conditions on joined fields). */
  private buildMatchStages(): {
    pre: PipelineStage.Match | null;
    post: PipelineStage.Match | null;
  } {
    const preClauses: Record<string, unknown>[] = [];
    const postClauses: Record<string, unknown>[] = [];
    const add = (
      arr: Record<string, unknown>[],
      c: Record<string, unknown>,
    ) => {
      if (Object.keys(c).length > 0) arr.push(c);
    };

    const url = this.splitConditions(this._urlFilter);
    add(preClauses, url.pre);
    add(postClauses, url.post);

    if (this._searchOr.length > 0) {
      const clause = { $or: this._searchOr };
      const joined = this._searchOr.some((o) =>
        Object.keys(o).some((k) => this.isJoinedKey(k)),
      );
      (joined ? postClauses : preClauses).push(clause);
    }

    for (const cond of this._serverConditions) {
      const s = this.splitConditions(cond);
      add(preClauses, s.pre);
      add(postClauses, s.post);
    }

    const mk = (c: Record<string, unknown>[]): PipelineStage.Match | null =>
      c.length === 0 ? null : { $match: c.length === 1 ? c[0] : { $and: c } };

    return { pre: mk(preClauses), post: mk(postClauses) };
  }

  /** Match + lookups/custom stages only, no $project/$sort — shared by count()/distinct()/stats()/paginateCursor(). */
  private buildHeadPipeline(): PipelineStage[] {
    const { pre, post } = this.buildMatchStages();
    const pipeline: PipelineStage[] = [];
    if (pre) pipeline.push(pre);
    if (post) {
      const idx = Math.min(this._postJoinIndex, this._stages.length);
      pipeline.push(
        ...this._stages.slice(0, idx),
        post,
        ...this._stages.slice(idx),
      );
    } else {
      pipeline.push(...this._stages);
    }
    return pipeline;
  }

  /**
   * Base pipeline shared by every execution path:
   * match -> lookups/custom stages -> sort -> [skip/limit] -> project.
   * $project runs last so it can never drop a field that sorting needs,
   * and only touches the documents that survive skip/limit.
   */
  private buildBasePipeline(range?: {
    skip: number;
    limit: number;
  }): PipelineStage[] {
    const pipeline = this.buildHeadPipeline();
    pipeline.push({ $sort: this.effectiveSort() });
    if (range) {
      if (range.skip > 0) pipeline.push({ $skip: range.skip });
      pipeline.push({ $limit: range.limit });
    }
    if (this._projection) pipeline.push({ $project: this._projection });
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
    const { onSlowQuery, slowQueryThresholdMS } = this.options;
    if (!onSlowQuery) return fn();

    const start = Date.now();
    try {
      return await fn();
    } finally {
      const elapsedMs = Date.now() - start;
      if (elapsedMs >= slowQueryThresholdMS) {
        try {
          onSlowQuery({
            elapsedMs,
            pipeline,
            sort: this.effectiveSort(),
            page,
            limit,
          });
        } catch {
          // A faulty logging callback must never break the query.
        }
      }
    }
  }

  private fetchPage(page: number, limit: number): Promise<T[]> {
    const pipeline = this.buildBasePipeline({
      skip: (page - 1) * limit,
      limit,
    });
    return this.wrapTimed(
      () => this.execAggregate<T>(pipeline),
      page,
      limit,
      pipeline,
    );
  }

  private async runCount(page: number, limit: number): Promise<number> {
    const pipeline: PipelineStage[] = [
      ...this.buildHeadPipeline(),
      { $count: 'count' },
    ];
    const [row] = await this.wrapTimed(
      () => this.execAggregate<{ count: number }>(pipeline),
      page,
      limit,
      pipeline,
    );
    return row?.count ?? 0;
  }

  // ── Terminal ───────────────────────────────────────────────────────────────

  /**
   * Executes the pipeline and returns a paginated result. The data page
   * (sort + skip + limit, so MongoDB can use top-k / index sorting) and the
   * total count run in parallel. Pass a prior page-1 `total` as `cachedTotal`
   * on later pages to skip the count entirely.
   */
  async paginate(cachedTotal?: number): Promise<PaginatedResult<T>> {
    const page = this._page;
    const limit = this._limit;

    if (cachedTotal !== undefined) {
      if (!Number.isInteger(cachedTotal) || cachedTotal < 0) {
        throw new QueryAggregateValidationError(
          `paginate: "cachedTotal" must be a non-negative integer, got ${cachedTotal}`,
        );
      }
      const totalPages = Math.max(Math.ceil(cachedTotal / limit), 1);
      const safePage = page > totalPages ? 1 : page;
      const data = await this.fetchPage(safePage, limit);
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

    const [pageData, total] = await Promise.all([
      this.fetchPage(page, limit),
      this.runCount(page, limit),
    ]);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    if (page > totalPages) {
      // Requested page doesn't exist for this filter — return page 1 rather
      // than an empty page silently.
      const data = await this.fetchPage(1, limit);
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
      data: pageData,
      total,
      page,
      totalPages,
      limit,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }

  // ── Advanced terminal & utility methods ───────────────────────────────────

  /** Returns just the matching document count — cheaper than paginate() when you don't need the data page. Ignores $project/$sort. */
  async count(): Promise<number> {
    const pipeline: PipelineStage[] = [
      ...this.buildHeadPipeline(),
      { $count: 'count' },
    ];
    const [row] = await this.execAggregate<{ count: number }>(pipeline);
    return row?.count ?? 0;
  }

  /** Returns the distinct values of `field` for the current filter/where/range conditions. */
  async distinct<V = unknown>(field: string): Promise<V[]> {
    assertFieldPath(field, 'distinct');
    const pipeline: PipelineStage[] = [
      ...this.buildHeadPipeline(),
      { $group: { _id: `$${field}` } },
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
      if (
        !METRIC_NAME_RE.test(spec.name) ||
        spec.name === '_id' ||
        DANGEROUS_KEYS.has(spec.name)
      ) {
        throw new QueryAggregateValidationError(
          `stats: invalid metric name "${spec.name}"`,
        );
      }
      if (!STAT_OPS.has(spec.op)) {
        throw new QueryAggregateValidationError(
          `stats: unsupported op "${String(spec.op)}" for metric "${spec.name}"`,
        );
      }
      if (spec.op === 'count') {
        group[spec.name] = { $sum: 1 };
      } else {
        if (!spec.field) {
          throw new QueryAggregateValidationError(
            `stats: metric "${spec.name}" needs a "field" for op "${spec.op}"`,
          );
        }
        assertFieldPath(spec.field, `stats(${spec.name})`);
        group[spec.name] = { [`$${spec.op}`]: `$${spec.field}` };
      }
    }

    const pipeline: PipelineStage[] = [
      ...this.buildHeadPipeline(),
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
   * "jump to page N". Seeks on the FIRST field of .sort() (falls back to
   * DEFAULT_SORT's `createdAt`) with `_id` as a stable tiebreaker. Pass the
   * previous page's `nextCursor` back in as `cursor` to continue; a
   * `hasNextPage: false` / `nextCursor: null` page is the end. A cursor is
   * bound to the sort field/direction it was created with.
   */
  async paginateCursor(
    opts: CursorPaginateOptions = {},
  ): Promise<CursorPaginatedResult<T>> {
    const limit =
      typeof opts.limit === 'number' &&
      Number.isFinite(opts.limit) &&
      opts.limit >= 1
        ? Math.min(Math.floor(opts.limit), this.options.maxLimit)
        : this._limit;

    const first = Object.entries(this._sort)[0] ?? ['createdAt', -1];
    const sortField = first[0];
    const sortDir: SortDir = first[1] === 1 ? 1 : -1;

    const pipeline = this.buildHeadPipeline();

    if (opts.cursor) {
      const { v, id } = this.decodeCursor(opts.cursor, sortField, sortDir);
      pipeline.push({
        $match: this.buildCursorMatch(sortField, sortDir, v, id),
      });
    }

    pipeline.push({
      $sort:
        sortField === '_id'
          ? { _id: sortDir }
          : { [sortField]: sortDir, _id: sortDir },
    });
    pipeline.push({ $limit: limit + 1 });

    // Projection goes last; the sort field and `_id` are force-included for
    // cursor creation and stripped again from the returned rows.
    const { projection, injectId, injectSort } =
      this.buildCursorProjection(sortField);
    if (projection) pipeline.push({ $project: projection });

    const rows = await this.wrapTimed(
      () => this.execAggregate<Record<string, unknown>>(pipeline),
      1,
      limit,
      pipeline,
    );

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasNextPage && pageRows.length > 0
        ? this.encodeCursor(pageRows[pageRows.length - 1], sortField, sortDir)
        : null;

    if (injectId || injectSort) {
      for (const row of pageRows) {
        if (injectId) delete row._id;
        if (injectSort) deletePath(row, sortField);
      }
    }

    return { data: pageRows as unknown as T[], limit, nextCursor, hasNextPage };
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
    assertFieldPath(name, 'computeField');
    return this.addStage({
      $addFields: { [name]: expression },
    } as PipelineStage);
  }

  /** Convenience server-side condition excluding soft-deleted docs (matches both `null` and a missing field, per MongoDB equality semantics). Not client-overridable. */
  excludeSoftDeleted(field = 'deletedAt'): this {
    this._serverConditions.push({ [field]: null });
    return this;
  }

  /** Applies .where(conditions) only when `condition` is truthy — avoids scattering if-statements around chained builder calls. */
  whereIf(condition: unknown, conditions: WhereConditions<T>): this {
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
    copy._serverConditions = [...this._serverConditions];
    copy._searchOr = [...this._searchOr];
    copy._sort = { ...this._sort };
    copy._projection = this._projection ? { ...this._projection } : null;
    copy._defaultProjection = this._defaultProjection
      ? { ...this._defaultProjection }
      : null;
    copy._stages = [...this._stages];
    copy._joinAliases = new Set(this._joinAliases);
    copy._postJoinIndex = this._postJoinIndex;
    return copy;
  }

  /** Returns the fully-built pipeline without executing it — for logging, snapshot tests, or sanity-checking what will actually run. */
  debugPipeline(): PipelineStage[] {
    return this.buildBasePipeline();
  }

  // ── Cursor internals ──────────────────────────────────────────────────────

  private buildCursorProjection(sortField: string): {
    projection: Record<string, 0 | 1> | null;
    injectId: boolean;
    injectSort: boolean;
  } {
    const proj = this._projection;
    if (!proj) return { projection: null, injectId: false, injectSort: false };

    const p: Record<string, 0 | 1> = { ...proj };
    let injectId = false;
    let injectSort = false;
    const needSort = sortField !== '_id';
    const isInclusion = Object.keys(p).some((k) => k !== '_id' && p[k] === 1);

    const conflict = () =>
      new QueryAggregateValidationError(
        `paginateCursor: projection conflicts with sort field "${sortField}" (a parent/child path of it is projected)`,
      );

    if (p._id === 0) {
      delete p._id;
      injectId = true;
    }

    if (needSort) {
      if (isInclusion) {
        const covered = Object.keys(p).some(
          (k) =>
            p[k] === 1 && (k === sortField || sortField.startsWith(`${k}.`)),
        );
        if (!covered) {
          if (Object.keys(p).some((k) => k.startsWith(`${sortField}.`)))
            throw conflict();
          p[sortField] = 1;
          injectSort = true;
        }
      } else {
        if (p[sortField] === 0) {
          delete p[sortField];
          injectSort = true;
        } else if (Object.keys(p).some((k) => sortField.startsWith(`${k}.`))) {
          throw conflict();
        }
      }
    }

    return {
      projection: Object.keys(p).length > 0 ? p : null,
      injectId,
      injectSort,
    };
  }

  /** Encodes a keyset cursor from a result row: the sort field's value plus `_id` as a stable tiebreaker. */
  private encodeCursor(
    doc: Record<string, unknown>,
    sortField: string,
    sortDir: SortDir,
  ): string {
    const payload: CursorPayload = {
      f: sortField,
      d: sortDir,
      v: encodeTyped(getByPath(doc, sortField)),
      id: encodeTyped(doc._id),
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  /** Decodes and strictly validates a cursor, restoring Date/ObjectId typing so comparisons stay type-correct. */
  private decodeCursor(
    cursor: string,
    sortField: string,
    sortDir: SortDir,
  ): { v: unknown; id: unknown } {
    const bad = () =>
      new QueryAggregateValidationError('paginateCursor: invalid cursor');
    if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH)
      throw bad();

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw bad();
    }
    if (!isPlainObject(parsed)) throw bad();
    const c = parsed as Partial<CursorPayload>;
    if (c.f !== sortField || c.d !== sortDir) {
      throw new QueryAggregateValidationError(
        'paginateCursor: cursor does not match the current sort',
      );
    }
    return { v: decodeTyped(c.v), id: decodeTyped(c.id) };
  }

  /** $match selecting every row strictly after the cursor row in (sortField, _id) order — null/missing-safe. */
  private buildCursorMatch(
    sortField: string,
    sortDir: SortDir,
    v: unknown,
    id: unknown,
  ): Record<string, unknown> {
    const cmp = sortDir === -1 ? '$lt' : '$gt';
    const tie = { _id: { [cmp]: id } };

    if (sortField === '_id') return { _id: { [cmp]: id } };

    // MongoDB sorts null/missing first ascending, last descending.
    if (v === null) {
      return sortDir === 1
        ? {
            $or: [
              { [sortField]: { $ne: null } },
              { [sortField]: null, ...tie },
            ],
          }
        : { [sortField]: null, ...tie };
    }

    const or: Record<string, unknown>[] = [
      { [sortField]: { [cmp]: v } },
      { [sortField]: v, ...tie },
    ];
    if (sortDir === -1) or.push({ [sortField]: null });
    return { $or: or };
  }
}

export default QueryAggregate;