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
 *  - Coerces string booleans and date strings into proper types
 *  - Supports safe top-level logical operators ($and / $or / $nor / $not)
 *  - Enforces an allowlist for fields that may be filtered, sorted, or selected
 *  - Provides global (case-insensitive) regex search across specified fields
 *  - Supports population, select (projection), sorting, and pagination
 *  - Emits slow-query notifications when configured
 *
 * New: maxLimit option (customizable)
 * ----------------------------------
 * By default the per-page `limit` is capped at 100. You can override this
 * by passing `maxLimit` in the QueryFind options:
 *
 * const result = await queryFind(User.find(), req.query, { maxLimit: 250 }).paginate();
 *
 * If the client requests ?limit=500 but maxLimit is 250, the effective limit
 * will be min(requestedLimit, maxLimit).
 *
 * Installation
 * ------------
 * npm:
 *   npm install mongoose-query-find
 *
 * Yarn:
 *   yarn add mongoose-query-find
 *
 * Usage
 * -----
 * Example typical usage inside an Express route handler:
 *
 * import { queryFind } from 'mongoose-query-find';
 * import User from './models/User';
 *
 * app.get('/users', async (req, res, next) => {
 *   try {
 *     const result = await queryFind(User.find(), req.query, {
 *       maxTimeMS: 2000,
 *       maxLimit: 250, // <- custom max limit per page
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
 *   Factory convenience wrapper around `new QueryFind(...)`.
 *
 * - new QueryFind(query, queryString, options?)
 *   Constructor parameters:
 *     - query: a Mongoose Query instance (e.g. Model.find())
 *     - queryString: parsed URL query parameters (e.g. req.query)
 *     - options (optional):
 *         - maxTimeMS?: number (default: 5000)
 *         - slowQueryThresholdMS?: number (defaults to maxTimeMS)
 *         - maxLimit?: number (default: 100) <-- NEW
 *         - onSlowQuery?: (info: SlowQueryInfo) => void
 *         - onSanitizeDrop?: (path: string, value: unknown) => void
 *         - lean?: boolean (default: true)
 *
 * (rest of API documentation unchanged)
 *
 * Copyright and License
 * ---------------------
 * MIT
 */

import mongoose, { Model, PopulateOptions, Query } from 'mongoose';

type MFilter<T> = mongoose.QueryFilter<T>;

// ─── Constants ────────────────────────────────────────────────────────────────

const RESERVED_KEYS = new Set<string>(['page', 'sort', 'limit', 'fields', 'q']);
const DEFAULT_MAX_LIMIT = 100;
const MAX_NESTING_DEPTH = 5;
const MAX_SEARCH_LENGTH = 200;
const MAX_SORT_FIELDS = 5;
const DEFAULT_MAX_TIME_MS = 5_000;

// Matches only when the date-word is the LAST path segment (e.g. "createdAt",
// "user.updatedAt") — not an arbitrary substring like "myUpdatedAt".
const DATE_FIELD_RE =
  /(^|\.)(createdAt|updatedAt|deletedAt|date|birthDate|expiresAt)$/i;
const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
  page: number;
  limit: number;
}

export interface QueryFindOptions {
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

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Recursively strips non-plain values (class instances, functions) from an
 * arbitrary object so only JSON-safe primitives/plain objects/Dates reach the
 * query pipeline. Notifies the caller via onDrop when values are removed.
 *
 * BUG FIX: Changed depth check from `>` to `>=` to properly enforce MAX_NESTING_DEPTH.
 * This prevents nesting deeper than 5 levels (0, 1, 2, 3, 4 are allowed; 5+ rejected).
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
 * ($and/$or/$nor/$not and any nested operator) are recursed into so that a
 * client cannot bypass the field allowlist by wrapping a disallowed field
 * inside a logical operator (e.g. ?$or[0][secretField]=x).
 */
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

// ─── Fused coercion pass ──────────────────────────────────────────────────────

/**
 * Single-pass coercion:
 *  - 'true' / 'false' strings → booleans
 *  - Date-field strings → Date objects ($gte/$lt range for plain YYYY-MM-DD)
 *  - Shorthand operator keys (eq, ne, gt, …) → prefixed form ($eq, $ne, …)
 *
 * Inside an $in/$nin array, plain-date strings are coerced to a scalar Date
 * rather than a {$gte,$lt} range object, since $in/$nin require scalar values.
 *
 * OPTIMIZATION: Filter out undefined values before pushing to avoid bloating arrays
 * with undefined entries that would be skipped later anyway.
 */
function coerceAll(value: unknown, parentKey = '', parentOp?: string): unknown {
  if (value === null) return null;

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;

    if (DATE_FIELD_RE.test(parentKey)) {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        if (PLAIN_DATE_RE.test(value)) {
          if (parentOp && IN_LIKE_OPS.has(parentOp)) return parsed;
          const start = new Date(value);
          const end = new Date(start);
          end.setUTCDate(end.getUTCDate() + 1);
          return { $gte: start, $lt: end };
        }
        return parsed;
      }
    }
    return value;
  }

  if (typeof value !== 'object' || value instanceof Date) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const coerced = coerceAll(value[i], parentKey, parentOp);
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
    // Reset parentOp when descending into a new field (isOp=false) so a
    // stale $in/$nin context from a sibling branch can't leak in.
    out[newKey] = coerceAll(src[k], childPath, isOp ? k : undefined);
  }
  return out;
}

// ─── Operator validation ──────────────────────────────────────────────────────

/**
 * Throws on any BANNED_OPERATORS key at any depth, and on any top-level $ key
 * that isn't in ALLOWED_TOP_LEVEL_OPS.
 */
function rejectDisallowedOperators(
  filter: Record<string, unknown>,
  depth = 0,
): void {
  for (const k in filter) {
    if (!Object.prototype.hasOwnProperty.call(filter, k)) continue;

    if (BANNED_OPERATORS.has(k)) {
      throw new QueryFindValidationError(
        `Disallowed operator in query: "${k}"`,
      );
    }
    if (depth === 0 && k.startsWith('$') && !ALLOWED_TOP_LEVEL_OPS.has(k)) {
      throw new QueryFindValidationError(
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

// ─── Filter builder ───────────────────────────────────────────────────────────

function buildFilter(
  raw: QueryParams,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
  onDrop?: (path: string, value: unknown) => void,
): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const k in raw) {
    if (Object.prototype.hasOwnProperty.call(raw, k) && !RESERVED_KEYS.has(k)) {
      stripped[k] = raw[k];
    }
  }

  const safe = sanitize(stripped, 0, '', onDrop) as Record<string, unknown>;
  const coerced = coerceAll(safe) as Record<string, unknown>;
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

// ─── Projection sanitizer ─────────────────────────────────────────────────────

/**
 * Filters a space-separated projection string against the allowlist and
 * normalizes each field to its canonical case. _id and __v are always
 * permitted. Returns '' when every token is blocked — callers must handle
 * this explicitly to avoid an accidental "select everything".
 */
function sanitizeProjection(
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

// ─── QueryFind ────────────────────────────────────────────────────────────────

/**
 * Fluent query builder / paginator for Mongoose 8/9.
 *
 * @example
 * const result = await new QueryFind(User.find(), req.query)
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
  private readonly options: Required<
    Omit<QueryFindOptions, 'onSlowQuery' | 'onSanitizeDrop'>
  > &
    Pick<QueryFindOptions, 'onSlowQuery' | 'onSanitizeDrop'>;

  private _allowedLookup: Set<string> = new Set();
  private _canonicalMap: Map<string, string> = new Map();

  /**
   * URL-derived filter and server conditions are kept separate so server
   * conditions (merged last, in buildFinalFilter) can never be overridden by
   * URL params, regardless of call order between where() and filter().
   */
  private _urlFilter: Record<string, unknown> = {};
  private _serverConditions: Record<string, unknown> = {};

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
    this.options = {
      maxTimeMS: options.maxTimeMS ?? DEFAULT_MAX_TIME_MS,
      slowQueryThresholdMS:
        options.slowQueryThresholdMS ??
        options.maxTimeMS ??
        DEFAULT_MAX_TIME_MS,
      maxLimit: options.maxLimit ?? DEFAULT_MAX_LIMIT,
      lean: options.lean ?? true,
      onSlowQuery: options.onSlowQuery,
      onSanitizeDrop: options.onSanitizeDrop,
    };
    this._page = parsePage(this.qs.page);
    this._limit = parseLimit(this.qs.limit, this.options.maxLimit);
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
   * fields nested inside $and/$or/$nor/$not). Reserved keys are stripped first.
   */
  filter(): this {
    const parsed = buildFilter(
      this.qs,
      this._allowedLookup,
      this._canonicalMap,
      this.options.onSanitizeDrop,
    );
    Object.assign(this._urlFilter, parsed);
    return this;
  }

  /**
   * Mandatory server-side conditions the client cannot override — merged
   * into the final filter last. Values are not sanitized (ObjectIds, Dates,
   * etc. are valid); banned $ operators are still rejected.
   */
  where(conditions: Partial<Record<keyof TRawDocType, unknown>>): this {
    const asRecord = conditions as Record<string, unknown>;
    rejectDisallowedOperators(asRecord);
    Object.assign(this._serverConditions, asRecord);
    return this;
  }

  /**
   * Enables case-insensitive full-text search across the given fields when
   * ?q= is present. Fields not in allowFields() are skipped. Safe to call
   * multiple times — extends the $or list rather than re-wrapping the filter.
   */
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

  /**
   * Parses ?sort= (e.g. "-createdAt,name") into a Mongoose sort object.
   * Fields not in allowFields() are dropped; falls back to DEFAULT_SORT.
   */
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
   * Controls which fields are returned. When ?fields= is present, it's
   * parsed and filtered through the allowlist; when every requested field is
   * blocked, falls back to `defaultFields` instead of selecting everything.
   * When ?fields= is absent, `defaultFields` is used as-is.
   */
  limitFields(defaultFields?: string): this {
    if (defaultFields) this._defaultFields = defaultFields;

    if (this.qs.fields) {
      const raw = this.qs.fields
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
   * stripped) and boolean/date strings coerced, then checked for banned
   * operators — but NOT restricted to the main model's allowFields(), since
   * the populated model may have an entirely different schema.
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
      const coercedMatch = coerceAll(safeMatch) as Record<string, unknown>;
      rejectDisallowedOperators(coercedMatch);
      this._populates.push({ ...path, match: coercedMatch });
    } else {
      this._populates.push(path);
    }
    return this;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Assembles the final filter from three sources:
   *   1. URL-derived filter (client controlled)
   *   2. Global search $or clause
   *   3. Server conditions (highest priority)
   *
   * Combined with $and rather than object-spread, so a server condition on
   * the same field as a URL filter narrows the query instead of silently
   * discarding one side.
   *
   * OPTIMIZATION: Eliminated unnecessary object spreads. Use direct assignment
   * to reduce garbage collection pressure.
   */
  private buildFinalFilter(): Record<string, unknown> {
    let base: Record<string, unknown>;

    // Avoid spreading the URL filter; just use it directly initially
    const hasUrlFilter = Object.keys(this._urlFilter).length > 0;

    if (this._searchOr.length > 0) {
      if (hasUrlFilter) {
        base = { $and: [this._urlFilter, { $or: this._searchOr }] };
      } else {
        base = { $or: this._searchOr };
      }
    } else {
      base = hasUrlFilter ? this._urlFilter : {};
    }

    const hasServer = Object.keys(this._serverConditions).length > 0;

    if (Object.keys(base).length > 0 && hasServer) {
      return { $and: [base, this._serverConditions] };
    }
    if (hasServer) {
      return this._serverConditions;
    }
    return base;
  }

  private execFind(
    mongoFilter: MFilter<TRawDocType>,
    skip: number,
  ): Promise<TRawDocType[]> {
    const { maxTimeMS, lean } = this.options;
    const q = this.model
      .find(mongoFilter)
      .sort(this._sort)
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
      return (await this.model
        .estimatedDocumentCount()
        .maxTimeMS(maxTimeMS)
        .exec()) as number;
    }
    return (await this.model
      .countDocuments(mongoFilter)
      .maxTimeMS(maxTimeMS)
      .exec()) as number;
  }

  private async wrapTimed<R>(
    fn: () => Promise<R>,
    page: number,
    limit: number,
    filter: Record<string, unknown>,
  ): Promise<R> {
    const { onSlowQuery, slowQueryThresholdMS, maxTimeMS } = this.options;
    if (!onSlowQuery) return fn();

    const start = Date.now();
    const result = await fn();
    const elapsedMs = Date.now() - start;

    if (elapsedMs >= (slowQueryThresholdMS ?? maxTimeMS)) {
      onSlowQuery({ elapsedMs, filter, sort: this._sort, page, limit });
    }
    return result;
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
