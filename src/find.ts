/**
 * QueryFind - Fluent query builder and paginator for Mongoose (v8 / v9)
 *
 * Package: mongoose-query-find
 *
 * Summary
 * -------
 * QueryFind is a safe, allowlisted, and fully-featured query builder for
 * Mongoose that:
 *  - Parses and sanitizes URL query parameters into Mongoose-friendly filters
 *  - Coerces string booleans and date strings into proper types (timezone-aware)
 *  - Supports safe top-level logical operators ($and / $or / $nor)
 *  - Enforces an allowlist for fields that may be filtered, sorted, or selected
 *  - Provides global (case-insensitive) regex search across specified fields
 *  - Supports population, select (projection), sorting, and pagination
 *  - Emits slow-query notifications when configured
 *
 * ── Timezone handling ───────────────────────────────────────────────────────
 * MongoDB always stores/compares dates in UTC. Clients think and filter in local
 * time (e.g. ?createdAt=2026-09-01 means "Sept 1st in the caller's timezone",
 * not UTC midnight). This builder resolves that with `date-fns-tz`:
 *
 *   - fromZonedTime(localString, tz) -> the exact UTC instant for a wall-clock
 *     time in `tz`. Used to turn a client-supplied local date into the correct
 *     $gte/$lt UTC range.
 *
 * The timezone is a per-request value, passed via the options object rather
 * than hardcoded, typically sourced from a header:
 *
 *   const timezone = (req.headers['x-timezone'] as string) ?? 'Asia/Dhaka';
 *   const result = await queryFind(User.find(), req.query, { timezone })...
 *
 * An invalid/unknown IANA timezone string never throws mid-query — it is
 * validated once at construction time and falls back to the default.
 *
 * Date coercion rules (for date-like fields):
 *   - "YYYY-MM-DD"                 -> whole local day [00:00, next 00:00) in tz
 *   - "YYYY-MM-DDTHH:mm:ss[.sss]"  -> local wall-clock time in tz
 *   - ISO string with Z / +06:00   -> absolute instant (timezone not applied)
 *   - ?createdAt[gte]=2026-09-01   -> start of that local day
 *   - ?createdAt[lte]=2026-09-30   -> last millisecond of that local day
 *   - ?createdAt[gt]=...  [lt]=... -> end / start of that local day
 *   - ?createdAt[eq]=... / [ne]=...-> whole-day range / negated whole-day range
 *
 * Installation
 * ------------
 *   npm install mongoose-query-find date-fns-tz
 *
 * Usage
 * -----
 * import { queryFind } from 'mongoose-query-find';
 * import User from './models/User';
 *
 * app.get('/users', async (req, res, next) => {
 *   try {
 *     const timezone = (req.headers['x-timezone'] as string) ?? 'Asia/Dhaka';
 *     const result = await queryFind(User.find(), req.query, {
 *       timezone,
 *       maxTimeMS: 2000,
 *       maxLimit: 250,
 *       onSlowQuery(info) {
 *         console.warn('Slow query', info);
 *       },
 *     })
 *       .allowFields(['name', 'email', 'role', 'createdAt'])
 *       .where({ orgId: req.user.orgId, deletedAt: null })
 *       .filter()
 *       .globalSearch(['name', 'email'])
 *       .sort()
 *       .limitFields('-password -__v')
 *       .populate('department', 'name')
 *       .paginate();
 *
 *     res.json(result);
 *   } catch (err) {
 *     next(err);
 *   }
 * });
 *
 * API (high-level)
 * ----------------
 * - queryFind(query, queryString, options?) -> QueryFind
 * - new QueryFind(query, queryString, options?)
 *     options (optional):
 *         - timezone?: string            IANA tz (default: 'Asia/Dhaka')
 *         - maxTimeMS?: number           (default: 5000)
 *         - slowQueryThresholdMS?: number (defaults to maxTimeMS)
 *         - maxLimit?: number            (default: 100)
 *         - onSlowQuery?: (info: SlowQueryInfo) => void
 *         - onSanitizeDrop?: (path: string, value: unknown) => void
 *         - lean?: boolean               (default: true)
 *
 * Copyright and License
 * ---------------------
 * MIT
 */

import { fromZonedTime } from 'date-fns-tz';
import mongoose, { Model, PopulateOptions, Query } from 'mongoose';

type MFilter<T> = mongoose.QueryFilter<T>;

// ─── Constants ────────────────────────────────────────────────────────────────

const RESERVED_KEYS = new Set<string>(['page', 'sort', 'limit', 'fields', 'q']);
const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;
const MAX_PAGE = 1_000_000_000;
const MAX_NESTING_DEPTH = 5;
const MAX_SEARCH_LENGTH = 200;
const MAX_SORT_FIELDS = 5;
const DEFAULT_MAX_TIME_MS = 5_000;
const DEFAULT_TIMEZONE = 'Asia/Dhaka';

// Matches only when the date-word is the LAST path segment (e.g. "createdAt",
// "user.updatedAt") — not an arbitrary substring like "myUpdatedAt".
const DATE_FIELD_RE =
  /(^|\.)(createdAt|updatedAt|deletedAt|date|birthDate|expiresAt)$/i;
const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A string that already carries its own UTC offset ("Z" or "+06:00") is
// treated as an absolute instant rather than a local wall-clock time.
const HAS_OFFSET_RE = /([Zz]|[+-]\d{2}:?\d{2})$/;

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

const DEFAULT_SORT: Record<string, 1 | -1> = { createdAt: -1 };
// NOTE: `$not` is not a valid top-level query operator in MongoDB, so it is not allowed here.
const ALLOWED_TOP_LEVEL_OPS = new Set(['$and', '$or', '$nor']);
const BANNED_OPERATORS = new Set([
  '$where',
  '$expr',
  '$function',
  '$accumulator',
  '$map',
  '$reduce',
  '$filter',
]);

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
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
  page: number;
  limit: number;
}

export interface QueryFindOptions {
  /** IANA timezone used to interpret client-supplied local dates, e.g. "Asia/Dhaka". Validated at construction; invalid values fall back to the default. */
  timezone?: string;
  maxTimeMS?: number;
  /** Threshold in ms above which onSlowQuery fires. Defaults to maxTimeMS. */
  slowQueryThresholdMS?: number;
  /** Maximum allowed `limit` per page. Defaults to 100. */
  maxLimit?: number;
  onSlowQuery?: (info: SlowQueryInfo) => void;
  /** Called when sanitize() silently drops a value. Defaults to console.warn outside production. */
  onSanitizeDrop?: (path: string, value: unknown) => void;
  /** Whether to call .lean() on find queries (default: true). */
  lean?: boolean;
}

/** Server-side conditions accepted by .where(). */
export type WhereConditions<T> =
  | Partial<Record<keyof T, unknown>>
  | Record<string, unknown>;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class QueryFindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryFindError';
  }
}

export class QueryFindValidationError extends QueryFindError {
  constructor(message: string) {
    super(message);
    this.name = 'QueryFindValidationError';
  }
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface ResolvedOptions {
  timezone: string;
  maxTimeMS: number;
  slowQueryThresholdMS: number;
  maxLimit: number;
  lean: boolean;
  onSlowQuery?: (info: SlowQueryInfo) => void;
  onSanitizeDrop?: (path: string, value: unknown) => void;
}

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
        `[query-find] Invalid timezone "${candidate}", falling back to "${DEFAULT_TIMEZONE}"`,
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

/**
 * Coerces a date string for a date-like field. `op` is the bare comparison
 * operator ("gt", "lte", "in", ...) or undefined for a direct field value.
 */
function coerceDateValue(
  value: string,
  op: string | undefined,
  timezone: string,
): unknown {
  if (op && IN_LIKE_OPS.has(op)) {
    // $in/$nin require scalar values, not ranges.
    return coerceDateScalar(value, timezone) ?? value;
  }
  if (isRealPlainDate(value)) {
    const { start, end } = plainDateToUtcRange(value, timezone);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return value;
    switch (op) {
      case undefined:
        return { $gte: start, $lt: end };
      case 'gt':
        return end;
      case 'lte':
        return new Date(end.getTime() - 1);
      default: // gte / lt / eq / ne (eq/ne are normally intercepted earlier)
        return start;
    }
  }
  return coerceDateScalar(value, timezone) ?? value;
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v instanceof Date) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively strips non-plain values (class instances, functions) from an
 * arbitrary object so only JSON-safe primitives/plain objects/Dates reach the
 * query pipeline. Notifies the caller via onDrop when values are removed.
 *
 * Depth check uses `>=` to properly enforce MAX_NESTING_DEPTH (levels 0–4
 * allowed; 5+ rejected). Prototype-polluting keys are skipped.
 */
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
        `[query-find] Max nesting depth exceeded at "${path}":`,
        value,
      );
    }
    return undefined;
  }

  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;

  // Dates are valid, JSON-safe query values (e.g. developer-supplied populate.match) — keep them.
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
    console.warn(`[query-find] Dropped non-plain value at "${path}":`, value);
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

/**
 * Removes any non-operator key not present in the allowlist. Operator keys
 * ($and/$or/$nor and any nested operator) are recursed into so that a
 * client cannot bypass the field allowlist by wrapping a disallowed field
 * inside a logical operator (e.g. ?$or[0][secretField]=x).
 *
 * Clauses that were fully stripped are dropped (an empty clause would
 * otherwise match everything inside $or).
 */
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

// ─── Fused coercion pass ──────────────────────────────────────────────────────

/**
 * Single-pass coercion:
 *  - 'true' / 'false' strings → booleans
 *  - Date-field strings → Date objects, interpreted in `timezone`
 *    (plain YYYY-MM-DD → whole-local-day range or boundary depending on op)
 *  - Shorthand operator keys (eq, ne, gt, …) → prefixed form ($eq, $ne, …)
 *  - ?field[in]=a,b,c → ['a','b','c']
 *
 * Inside an $in/$nin array, plain-date strings are coerced to a scalar Date
 * rather than a {$gte,$lt} range object, since $in/$nin require scalar values.
 * `parentOp` is the BARE operator name (no leading "$").
 */
function coerceAll(
  value: unknown,
  timezone: string,
  parentKey = '',
  parentOp?: string,
): unknown {
  if (value === null) return null;

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;

    if (
      DATE_FIELD_RE.test(parentKey) &&
      (!parentOp || COERCIBLE_OPS.has(parentOp))
    ) {
      return coerceDateValue(value, parentOp, timezone);
    }
    return value;
  }

  if (typeof value !== 'object' || value instanceof Date) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const coerced = coerceAll(item, timezone, parentKey, parentOp);
      if (coerced !== undefined) out.push(coerced);
    }
    return out;
  }

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    const v = src[k];

    const isOp = k.startsWith('$') || COERCIBLE_OPS.has(k);
    if (!isOp) {
      // Reset parentOp when descending into a new field so a stale
      // $in/$nin context from a sibling branch can't leak in.
      out[k] = coerceAll(
        v,
        timezone,
        parentKey ? `${parentKey}.${k}` : k,
        undefined,
      );
      continue;
    }

    const bare = k.startsWith('$') ? k.slice(1) : k;
    const outKey = k.startsWith('$') ? k : `$${k}`;

    // ?field[eq]=2026-09-01 / [ne]= on a date field -> whole-day range semantics.
    if (
      (bare === 'eq' || bare === 'ne') &&
      typeof v === 'string' &&
      isRealPlainDate(v) &&
      DATE_FIELD_RE.test(parentKey)
    ) {
      const { start, end } = plainDateToUtcRange(v, timezone);
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

    out[outKey] = coerceAll(child, timezone, parentKey, bare);
  }
  return out;
}

// ─── Operator validation ──────────────────────────────────────────────────────

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
      throw new QueryFindValidationError(
        `Disallowed operator in query: "${k}"`,
      );
    }
    const v = filter[k];

    if (topLevelCheck && depth === 0 && k.startsWith('$')) {
      if (!ALLOWED_TOP_LEVEL_OPS.has(k)) {
        throw new QueryFindValidationError(
          `Disallowed top-level operator in query string: "${k}"`,
        );
      }
      if (!Array.isArray(v) || v.length === 0 || !v.every(isPlainObject)) {
        throw new QueryFindValidationError(
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

// ─── Filter builder ───────────────────────────────────────────────────────────

function buildFilter(
  raw: QueryParams,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
  timezone: string,
  onDrop?: (path: string, value: unknown) => void,
): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) {
    if (!RESERVED_KEYS.has(k) && !DANGEROUS_KEYS.has(k)) stripped[k] = raw[k];
  }

  const safe = sanitize(stripped, 0, '', onDrop) as Record<string, unknown>;
  const coerced = coerceAll(safe, timezone) as Record<string, unknown>;
  const allowed = enforceAllowlist(coerced, allowedLookup, canonicalMap);
  rejectDisallowedOperators(allowed);
  return allowed;
}

// ─── Sort parser ──────────────────────────────────────────────────────────────

/**
 * Parses "-createdAt,name" into a Mongoose sort object. Fields not in the
 * allowlist are skipped. Capped at MAX_SORT_FIELDS. Falls back to
 * DEFAULT_SORT when nothing valid was parsed.
 */
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

// ─── Projection sanitizer ─────────────────────────────────────────────────────

/**
 * Filters a space-separated projection string against the allowlist and
 * normalizes each field to its canonical case. _id and __v are always
 * permitted. `+field` (force-select hidden fields) and `$` tokens are never
 * accepted from the client. Returns '' when every token is blocked — callers
 * must handle this explicitly to avoid an accidental "select everything".
 */
function sanitizeProjection(
  projection: string,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
): string {
  const tokens = projection
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !token.startsWith('+') && !token.includes('$'));

  if (allowedLookup.size === 0) return tokens.join(' ');

  return tokens
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

// ─── QueryFind ────────────────────────────────────────────────────────────────

/**
 * Fluent query builder / paginator for Mongoose 8/9, with timezone-aware
 * date filtering.
 *
 * @example
 * const result = await new QueryFind(User.find(), req.query, { timezone })
 *   .allowFields(['name', 'email', 'role', 'createdAt'])
 *   .where({ orgId: req.user.orgId, deletedAt: null })
 *   .filter()
 *   .globalSearch(['name', 'email'])
 *   .sort()
 *   .limitFields('-password -__v')
 *   .populate('department', 'name')
 *   .paginate();
 */
export class QueryFind<
  TRawDocType,
  TModelType extends Model<TRawDocType> = Model<TRawDocType>,
> {
  private readonly model: TModelType;
  private readonly qs: Readonly<QueryParams>;
  private readonly options: ResolvedOptions;

  private _allowedLookup: Set<string> = new Set();
  private _canonicalMap: Map<string, string> = new Map();

  /**
   * URL-derived filter and server conditions are kept separate so server
   * conditions can never be overridden by URL params, regardless of call
   * order between where() and filter(). Server conditions are a list
   * (AND-ed together) so repeated where() calls on one field never
   * overwrite each other.
   */
  private _urlFilter: Record<string, unknown> = {};
  private _serverConditions: Record<string, unknown>[] = [];

  /** $or clauses from globalSearch(), assembled once in buildFinalFilter(). */
  private _searchOr: Record<string, unknown>[] = [];

  private _sort: Record<string, 1 | -1> = { ...DEFAULT_SORT };
  private _select: string | null = null;
  private _populates: PopulateOptions[] = [];

  /** Fallback projection when ?fields= is absent or fully blocked. */
  private _defaultFields: string | null = null;

  private readonly _page: number;
  private readonly _limit: number;

  constructor(
    query: Query<TRawDocType[], TRawDocType>,
    queryString: QueryParams,
    options: QueryFindOptions = {},
  ) {
    this.model = query.model as unknown as TModelType;
    this.qs = Object.freeze({ ...queryString });

    // Conditions already present on the passed-in query (e.g. User.find({ orgId }))
    // are kept as mandatory server conditions instead of being silently dropped.
    try {
      const base = query.getFilter?.() as Record<string, unknown> | undefined;
      if (base && Object.keys(base).length > 0) {
        this._serverConditions.push({ ...base });
      }
    } catch {
      // Ignore — a query without a readable filter simply contributes nothing.
    }

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

    this.options = {
      timezone: resolveTimezone(options.timezone),
      maxTimeMS,
      slowQueryThresholdMS:
        options.slowQueryThresholdMS ??
        (maxTimeMS > 0 ? maxTimeMS : DEFAULT_MAX_TIME_MS),
      maxLimit,
      lean: options.lean ?? true,
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

  /**
   * Declares which fields the client may filter, sort, and select. Must be
   * called before filter()/sort()/limitFields() to take effect. Matching is
   * case-insensitive: allowFields(['Name']) accepts ?name=, ?NAME=.
   */
  allowFields(fields: string[]): this {
    const { lookup, canonical } = buildAllowedStructures(new Set(fields));
    this._allowedLookup = lookup;
    this._canonicalMap = canonical;
    return this;
  }

  // ── Builder methods ───────────────────────────────────────────────────────

  /**
   * Parses URL query params into a Mongoose filter and merges them into the
   * URL-derived filter store. Only allowlisted fields pass through (including
   * fields nested inside $and/$or/$nor). Reserved keys are stripped first.
   * Date strings are interpreted in this instance's timezone.
   */
  filter(): this {
    const parsed = buildFilter(
      this.qs,
      this._allowedLookup,
      this._canonicalMap,
      this.options.timezone,
      this.options.onSanitizeDrop,
    );
    Object.assign(this._urlFilter, parsed);
    return this;
  }

  /**
   * Mandatory server-side conditions the client cannot override — AND-ed
   * with the final filter. Repeated calls are AND-ed together, never
   * overwritten. Values are not sanitized (ObjectIds, Dates, etc. are
   * valid); banned $ operators are still rejected, and `undefined` values
   * throw (an undefined condition would silently match everything).
   */
  where(conditions: WhereConditions<TRawDocType>): this {
    const asRecord = conditions as Record<string, unknown>;
    for (const k of Object.keys(asRecord)) {
      if (asRecord[k] === undefined) {
        throw new QueryFindValidationError(
          `where: condition for "${k}" is undefined`,
        );
      }
    }
    rejectDisallowedOperators(asRecord, 0, false);
    if (Object.keys(asRecord).length === 0) return this;
    this._serverConditions.push({ ...asRecord });
    return this;
  }

  /**
   * Enables case-insensitive full-text search across the given fields when
   * ?q= is present. Fields not in allowFields() are skipped. Safe to call
   * multiple times — extends the $or list rather than re-wrapping the filter.
   */
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

  /**
   * Parses ?sort= (e.g. "-createdAt,name") into a Mongoose sort object.
   * Fields not in allowFields() are dropped; falls back to DEFAULT_SORT.
   */
  sort(): this {
    const raw = asString(this.qs.sort);
    if (raw) {
      this._sort = parseSort(raw, this._allowedLookup, this._canonicalMap);
    }
    return this;
  }

  /**
   * Controls which fields are returned. When ?fields= is present, it's
   * parsed and filtered through the allowlist; when every requested field is
   * blocked, falls back to `defaultFields` instead of selecting everything.
   * When ?fields= is absent, `defaultFields` is used as-is.
   */
  limitFields(defaultFields?: string): this {
    if (defaultFields) this._defaultFields = defaultFields;

    const fieldsRaw = asString(this.qs.fields);
    if (fieldsRaw) {
      const raw = fieldsRaw
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
        .join(' ');
      const sanitized = sanitizeProjection(
        raw,
        this._allowedLookup,
        this._canonicalMap,
      );
      this._select = sanitized || this._defaultFields || null;
    } else if (defaultFields) {
      this._select = defaultFields;
    }
    return this;
  }

  /**
   * Registers a populate path. `match` is sanitized (non-plain values
   * stripped) and boolean/date strings coerced (dates in this instance's
   * timezone), then checked for banned operators — but NOT restricted to the
   * main model's allowFields(), since the populated model may have an
   * entirely different schema.
   */
  populate(path: string | PopulateOptions, select?: string): this {
    if (typeof path === 'string') {
      this._populates.push(select ? { path, select } : { path });
      return this;
    }

    if (path.match != null) {
      const safeMatch = sanitize(
        path.match,
        0,
        'populate.match',
        this.options.onSanitizeDrop,
      ) as Record<string, unknown>;
      const coercedMatch = coerceAll(
        safeMatch,
        this.options.timezone,
      ) as Record<string, unknown>;
      rejectDisallowedOperators(coercedMatch, 0, false);
      this._populates.push({ ...path, match: coercedMatch });
    } else {
      this._populates.push(path);
    }
    return this;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Effective sort: the requested sort plus `_id` as a stable tiebreaker
   * (prevents duplicate/missing rows across pages).
   */
  private effectiveSort(): Record<string, 1 | -1> {
    if ('_id' in this._sort) return { ...this._sort };
    const dir: 1 | -1 = Object.values(this._sort)[0] ?? -1;
    return { ...this._sort, _id: dir };
  }

  /**
   * Assembles the final filter from three sources:
   *   1. URL-derived filter (client controlled)
   *   2. Global search $or clause
   *   3. Server conditions (each AND-ed, so they can never be overridden)
   *
   * Combined with $and rather than object-spread, so a server condition on
   * the same field as a URL filter narrows the query instead of silently
   * discarding one side.
   */
  private buildFinalFilter(): Record<string, unknown> {
    const clauses: Record<string, unknown>[] = [];

    if (Object.keys(this._urlFilter).length > 0) clauses.push(this._urlFilter);
    if (this._searchOr.length > 0) clauses.push({ $or: this._searchOr });
    for (const cond of this._serverConditions) {
      if (Object.keys(cond).length > 0) clauses.push(cond);
    }

    if (clauses.length === 0) return {};
    if (clauses.length === 1) return clauses[0];
    return { $and: clauses };
  }

  private execFind(
    mongoFilter: MFilter<TRawDocType>,
    skip: number,
  ): Promise<TRawDocType[]> {
    const { maxTimeMS, lean } = this.options;
    const q = this.model
      .find(mongoFilter)
      .sort(this.effectiveSort())
      .skip(skip)
      .limit(this._limit);

    if (lean) q.lean();
    if (this._select) q.select(this._select);
    for (const opt of this._populates) q.populate(opt);
    if (maxTimeMS > 0) q.maxTimeMS(maxTimeMS);

    return q.exec() as Promise<TRawDocType[]>;
  }

  /** Uses estimatedDocumentCount for an O(1) count when no filter is active. */
  private async execCount(
    mongoFilter: MFilter<TRawDocType>,
    hasFilter: boolean,
  ): Promise<number> {
    const { maxTimeMS } = this.options;
    if (!hasFilter) {
      const q = this.model.estimatedDocumentCount();
      if (maxTimeMS > 0) q.maxTimeMS(maxTimeMS);
      return (await q.exec()) as number;
    }
    const q = this.model.countDocuments(mongoFilter);
    if (maxTimeMS > 0) q.maxTimeMS(maxTimeMS);
    return (await q.exec()) as number;
  }

  private async wrapTimed<R>(
    fn: () => Promise<R>,
    page: number,
    limit: number,
    filter: Record<string, unknown>,
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
            filter,
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

  // ── Terminal ───────────────────────────────────────────────────────────────

  /**
   * Executes the query and returns a paginated result. On page 1, count and
   * find run in parallel. Pass a prior page-1 `total` as `cachedTotal` on
   * later pages to skip the count query entirely.
   *
   * @throws {QueryFindValidationError} on a disallowed $ operator anywhere in the query.
   */
  async paginate(cachedTotal?: number): Promise<PaginatedResult<TRawDocType>> {
    const page = this._page;
    const limit = this._limit;
    const finalFilter = this.buildFinalFilter();
    const mongoFilter = finalFilter as MFilter<TRawDocType>;
    const hasFilter = Object.keys(finalFilter).length > 0;

    if (page === 1) {
      const [total, data] = await this.wrapTimed(
        () =>
          Promise.all([
            this.execCount(mongoFilter, hasFilter),
            this.execFind(mongoFilter, 0),
          ]),
        page,
        limit,
        finalFilter,
      );
      const totalPages = Math.max(Math.ceil(total / limit), 1);
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

    if (cachedTotal !== undefined) {
      if (!Number.isInteger(cachedTotal) || cachedTotal < 0) {
        throw new QueryFindValidationError(
          `paginate: "cachedTotal" must be a non-negative integer, got ${cachedTotal}`,
        );
      }
      const totalPages = Math.max(Math.ceil(cachedTotal / limit), 1);
      const safePage = page > totalPages ? 1 : page;
      const data = await this.wrapTimed(
        () => this.execFind(mongoFilter, (safePage - 1) * limit),
        safePage,
        limit,
        finalFilter,
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

    const result: {
      total: number;
      data: TRawDocType[];
      safePage: number;
      totalPages: number;
    } = {
      total: 0,
      data: [],
      safePage: page,
      totalPages: 1,
    };

    await this.wrapTimed(
      async () => {
        const total = await this.execCount(mongoFilter, hasFilter);
        const totalPages = Math.max(Math.ceil(total / limit), 1);
        const safePage = page > totalPages ? 1 : page;
        const data = await this.execFind(mongoFilter, (safePage - 1) * limit);
        result.total = total;
        result.data = data;
        result.safePage = safePage;
        result.totalPages = totalPages;
      },
      page,
      limit,
      finalFilter,
    );

    return {
      data: result.data,
      total: result.total,
      page: result.safePage,
      totalPages: result.totalPages,
      limit,
      hasNextPage: result.safePage < result.totalPages,
      hasPrevPage: result.safePage > 1,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Convenience factory — avoids `new` at the call site. */
export function queryFind<T>(
  query: Query<T[], T>,
  queryString: QueryParams,
  options?: QueryFindOptions,
): QueryFind<T> {
  return new QueryFind<T>(query, queryString, options);
}

export default QueryFind;
