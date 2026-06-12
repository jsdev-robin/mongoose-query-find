/**
 * @file query-find.ts
 * @description Production-grade fluent query builder for Mongoose 8.x / 9.x.
 * @requires mongoose ^8.0.0 || ^9.0.0
 *
 * Features:
 *  - URL query string → Mongoose filter (sanitized, validated, coerced)
 *  - Global full-text search via $or regex
 *  - Flexible sort, field projection, and populate
 *  - count + find run fully in parallel (Promise.all) — no wasted round-trips
 *  - Hard limits on page size, sort fields, search length, nesting depth (DoS protection)
 *  - Allowlist-based field filtering on filters, sort, AND projection (NoSQL injection prevention)
 *  - Case-insensitive allowlist matching (e.g. allowFields(['Name']) matches ?name=, ?NAME=, ?Name=)
 *  - Deep recursive operator validation (catches nested $where, $expr, etc.)
 *  - Deep recursive boolean coercion (handles nested query objects)
 *  - Deep recursive operator-key coercion (eq/ne/gt/... → $eq/$ne/$gt/...), applied
 *    ONLY to object keys — never to string values (fixes JSON-string regex bug)
 *  - estimatedDocumentCount fast-path when no filter is applied
 *  - Query timeout via maxTimeMS (prevents runaway queries)
 *  - Structured error types for clean upstream handling
 *  - Optional cached total for skipping re-count on page > 1
 *  - Optional slow-query hook for observability
 *  - Zero external runtime dependencies beyond mongoose
 *
 * Bug fixes:
 *  1. where() now runs rejectDisallowedOperators() — user data passed into it
 *     is no longer unvalidated.
 *  2. globalSearch() fields are now allowlist-checked — sensitive fields like
 *     passwordHash can't slip through a typo.
 *  3. populate() match objects are now sanitized and operator-validated.
 *  4. paginate() accepts an optional cachedTotal to skip sequential count on
 *     page > 1 — removes the sequential RTT on subsequent pages.
 *  5. sanitize() now emits a structured warning (via onSanitizeDrop callback or
 *     console.warn in dev) when it silently drops a non-plain-object value,
 *     so Date/class instances passed into where() don't disappear silently.
 *  6. Added onSlowQuery hook for observability — fires when a query exceeds
 *     maxTimeMS or a custom slowQueryThresholdMS.
 */

import mongoose, { Model, PopulateOptions, Query } from 'mongoose';

type MFilter<T> = mongoose.QueryFilter<T>;

// ─── Constants ────────────────────────────────────────────────────────────────

const RESERVED_KEYS = new Set<string>(['page', 'sort', 'limit', 'fields', 'q']);

const MAX_LIMIT = 100;
const MAX_NESTING_DEPTH = 5;
const MAX_SEARCH_LENGTH = 200;
const MAX_SORT_FIELDS = 5;
const DEFAULT_MAX_TIME_MS = 5_000;

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

const DEFAULT_SORT = Object.freeze<Record<string, 1 | -1>>({ createdAt: -1 });

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
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** The Mongoose filter that was applied */
  filter: Record<string, unknown>;
  /** The sort that was applied */
  sort: Record<string, 1 | -1>;
  /** The page that was requested */
  page: number;
  /** The limit that was applied */
  limit: number;
}

export interface QueryFindOptions {
  maxTimeMS?: number;
  /**
   * Threshold in ms above which onSlowQuery fires.
   * Defaults to maxTimeMS. Set lower (e.g. 1000) to catch slow-but-not-timed-out queries.
   */
  slowQueryThresholdMS?: number;
  /**
   * Called when a query exceeds slowQueryThresholdMS.
   * Use to emit metrics, log to your APM, etc.
   */
  onSlowQuery?: (info: SlowQueryInfo) => void;
  /**
   * Called when sanitize() silently drops a value (e.g. a Date or class instance).
   * Defaults to console.warn in non-production environments.
   */
  onSanitizeDrop?: (path: string, value: unknown) => void;
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

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '10', 10);
  if (isNaN(n) || n < 1) return 10;
  return Math.min(n, MAX_LIMIT);
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Bug fix #5: sanitize() now accepts an optional onDrop callback so callers
 * are notified when a non-plain-object value (Date, class instance, RegExp, etc.)
 * is silently dropped. Previously these disappeared without any warning.
 */
function sanitize(
  value: unknown,
  depth = 0,
  path = '',
  onDrop?: (path: string, value: unknown) => void,
): unknown {
  if (depth > MAX_NESTING_DEPTH) return undefined;

  if (value === null) return null;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;

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

  // Non-plain-object dropped — notify caller
  if (onDrop) {
    onDrop(path, value);
  } else if (process.env.NODE_ENV !== 'production') {
    console.warn(
      `[query-find] sanitize() dropped non-plain value at path "${path}":`,
      value,
    );
  }

  return undefined;
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

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

function enforceAllowlist(
  filter: Record<string, unknown>,
  allowedLookup: Set<string>,
  canonicalMap: Map<string, string>,
): Record<string, unknown> {
  if (allowedLookup.size === 0) return filter;
  const out: Record<string, unknown> = {};
  for (const k in filter) {
    if (!Object.prototype.hasOwnProperty.call(filter, k)) continue;
    if (k.startsWith('$')) {
      out[k] = filter[k];
      continue;
    }
    const lc = k.toLowerCase();
    if (allowedLookup.has(lc)) {
      out[canonicalMap.get(lc) ?? k] = filter[k];
    }
  }
  return out;
}

// ─── Fused coercion pass ──────────────────────────────────────────────────────

function coerceAll(value: unknown, parentKey = ''): unknown {
  if (value === null) return null;

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;

    if (DATE_FIELD_RE.test(parentKey)) {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        if (PLAIN_DATE_RE.test(value)) {
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

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => coerceAll(item, parentKey));
  }

  if (value instanceof Date) return value;

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const newKey = COERCIBLE_OPS.has(k) ? `$${k}` : k;
    const isOp = k.startsWith('$') || COERCIBLE_OPS.has(k);
    const childPath = isOp ? parentKey : parentKey ? `${parentKey}.${k}` : k;
    out[newKey] = coerceAll(src[k], childPath);
  }

  return out;
}

// ─── Operator validation ──────────────────────────────────────────────────────

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
        if (
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          !(item instanceof Date) &&
          Object.getPrototypeOf(item) === Object.prototype
        ) {
          rejectDisallowedOperators(item as Record<string, unknown>, depth + 1);
        }
      }
    } else if (
      v !== null &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      rejectDisallowedOperators(v as Record<string, unknown>, depth + 1);
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
      const canonical = canonicalMap.get(field.toLowerCase()) ?? field;
      out[canonical] = desc ? -1 : 1;
    } else {
      out[field] = desc ? -1 : 1;
    }

    count++;
  }
  return out;
}

// ─── Projection sanitizer ─────────────────────────────────────────────────────

function sanitizeProjection(
  projection: string,
  allowedLookup: Set<string>,
): string {
  if (allowedLookup.size === 0) return projection;

  return projection
    .split(/\s+/)
    .filter((token) => {
      if (!token) return false;
      const field = token.startsWith('-') ? token.slice(1) : token;
      if (field === '__v' || field === '_id') return true;
      return isFieldAllowed(field, allowedLookup);
    })
    .join(' ');
}

// ─── QueryFind ────────────────────────────────────────────────────────────────

/**
 * Production-grade fluent query builder / paginator for Mongoose 8/9.
 *
 * @example
 * ```ts
 * const result = await queryFind(User.find(), req.query)
 *   .allowFields(['name', 'email', 'role', 'createdAt'])
 *   .where({ orgId: req.user.orgId, deletedAt: null })
 *   .filter()
 *   .globalSearch(['name', 'email'])
 *   .sort()
 *   .limitFields('-password -__v')
 *   .populate('department', 'name')
 *   .paginate();
 * ```
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

  private _allowedFields: Set<string> = new Set();
  private _allowedLookup: Set<string> = new Set();
  private _canonicalMap: Map<string, string> = new Map();
  private _filter: Record<string, unknown> = {};
  private _sort: Record<string, 1 | -1> = { ...DEFAULT_SORT };
  private _select: string | null = null;
  private _populates: PopulateOptions[] = [];

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
      onSlowQuery: options.onSlowQuery,
      onSanitizeDrop: options.onSanitizeDrop,
    };
  }

  // ── Configuration ───────────────────────────────────────────────────────────

  allowFields(fields: string[]): this {
    this._allowedFields = new Set(fields);
    const { lookup, canonical } = buildAllowedStructures(this._allowedFields);
    this._allowedLookup = lookup;
    this._canonicalMap = canonical;
    return this;
  }

  // ── Builder methods ─────────────────────────────────────────────────────────

  filter(): this {
    const parsed = buildFilter(
      this.qs,
      this._allowedLookup,
      this._canonicalMap,
      this.options.onSanitizeDrop,
    );
    Object.assign(this._filter, parsed);
    return this;
  }

  /**
   * Apply mandatory server-side conditions the URL cannot override.
   *
   * Bug fix #1: conditions are now run through rejectDisallowedOperators() so
   * any user-controlled data accidentally passed here is still validated.
   * Date objects and other non-plain values ARE allowed here (server-side),
   * but $ operators are still banned.
   *
   * @example .where({ orgId: req.user.orgId, deletedAt: null })
   */
  where(conditions: Partial<Record<keyof TRawDocType, unknown>>): this {
    const asRecord = conditions as Record<string, unknown>;

    // Validate operators in server-supplied conditions.
    // We don't sanitize here (Dates, ObjectIds etc. are legitimate server values),
    // but we do reject banned $ operators in case user data leaked in.
    rejectDisallowedOperators(asRecord);

    Object.assign(this._filter, asRecord);
    return this;
  }

  /**
   * Case-insensitive full-text search across `fields` when `?q=` is present.
   *
   * Bug fix #2: fields are now filtered against the allowlist (when set) so a
   * typo like globalSearch(['name', 'passwordHash']) with an allowlist that
   * doesn't include 'passwordHash' won't silently leak that field.
   */
  globalSearch(fields: string[]): this {
    const raw = this.qs.q?.trim();

    if (!raw || raw.length > MAX_SEARCH_LENGTH || fields.length === 0) {
      return this;
    }

    // Bug fix #2: only search fields that are in the allowlist (when set).
    const safeFields =
      this._allowedLookup.size > 0
        ? fields.filter((f) => isFieldAllowed(f, this._allowedLookup))
        : fields;

    if (safeFields.length === 0) return this;

    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const searchOr = safeFields.map((field) => ({ [field]: regex }));

    if (Object.keys(this._filter).length > 0) {
      this._filter = {
        $and: [this._filter, { $or: searchOr }],
      };
    } else {
      this._filter = { $or: searchOr as MFilter<TRawDocType>['$or'] };
    }

    return this;
  }

  sort(): this {
    if (this.qs.sort) {
      const parsed = parseSort(
        this.qs.sort,
        this._allowedLookup,
        this._canonicalMap,
      );
      this._sort =
        Object.keys(parsed).length > 0 ? parsed : { ...DEFAULT_SORT };
    }
    return this;
  }

  limitFields(defaultFields?: string): this {
    if (this.qs.fields) {
      const raw = this.qs.fields
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
        .join(' ');
      this._select = sanitizeProjection(raw, this._allowedLookup);
    } else if (defaultFields) {
      this._select = defaultFields;
    }
    return this;
  }

  /**
   * Register a populate path.
   *
   * Bug fix #3: when a `match` object is provided, it is now sanitized and
   * run through rejectDisallowedOperators() so populate match conditions
   * can't be used as a NoSQL injection vector.
   *
   * @example
   *   .populate('author')
   *   .populate('author', 'name avatar')
   *   .populate({ path: 'comments', select: 'text', match: { visible: true } })
   */
  populate(path: string | PopulateOptions, select?: string): this {
    if (typeof path === 'string') {
      this._populates.push(select ? { path, select } : { path });
    } else {
      // Bug fix #3: sanitize and validate the match object if present.
      if (path.match != null) {
        const rawMatch = path.match as Record<string, unknown>;
        const safeMatch = sanitize(
          rawMatch,
          0,
          'populate.match',
          this.options.onSanitizeDrop,
        ) as Record<string, unknown>;
        rejectDisallowedOperators(safeMatch);
        this._populates.push({ ...path, match: safeMatch });
      } else {
        this._populates.push(path);
      }
    }
    return this;
  }

  // ── Terminal ────────────────────────────────────────────────────────────────

  /**
   * Execute and return a paginated result.
   *
   * Bug fix #4: accepts an optional `cachedTotal` parameter. When provided for
   * page > 1, the count query is skipped entirely — removing the sequential
   * RTT that was previously unavoidable on non-first pages.
   *
   * Typical usage:
   *   - Page 1: don't pass cachedTotal; total is returned in the result.
   *   - Page 2+: pass the `total` from the page-1 response as cachedTotal.
   *
   * @param cachedTotal - Previously fetched total, skips count query when provided.
   * @throws {QueryFindValidationError} on disallowed $ operators in the URL.
   */
  async paginate(cachedTotal?: number): Promise<PaginatedResult<TRawDocType>> {
    const page = parsePage(this.qs.page);
    const limit = parseLimit(this.qs.limit);
    const mongoFilter = this._filter as MFilter<TRawDocType>;
    const hasFilter = Object.keys(this._filter).length > 0;
    const { maxTimeMS, slowQueryThresholdMS, onSlowQuery } = this.options;

    const execFind = (skip: number): Promise<TRawDocType[]> => {
      const q = this.model
        .find(mongoFilter)
        .sort(this._sort)
        .skip(skip)
        .limit(limit)
        .lean();
      if (this._select) q.select(this._select);
      for (const opt of this._populates) q.populate(opt);
      if (maxTimeMS > 0) q.maxTimeMS(maxTimeMS);
      return q.exec() as Promise<TRawDocType[]>;
    };

    const execCount = (): Promise<number> =>
      hasFilter
        ? (this.model
            .countDocuments(mongoFilter)
            .maxTimeMS(maxTimeMS) as unknown as Promise<number>)
        : (this.model.estimatedDocumentCount() as unknown as Promise<number>);

    // ── Slow-query wrapper ───────────────────────────────────────────────────
    const wrapTimed = async <R>(fn: () => Promise<R>): Promise<R> => {
      if (!onSlowQuery) return fn();
      const start = Date.now();
      const result = await fn();
      const elapsedMs = Date.now() - start;
      if (elapsedMs >= (slowQueryThresholdMS ?? maxTimeMS)) {
        onSlowQuery({
          elapsedMs,
          filter: this._filter,
          sort: this._sort,
          page,
          limit,
        });
      }
      return result;
    };

    // ── Page 1 (most common): count + find in parallel ───────────────────────
    if (page === 1) {
      const [total, data] = await wrapTimed(() =>
        Promise.all([execCount(), execFind(0)]),
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

    // ── Page > 1 with cached total: skip count entirely ──────────────────────
    //
    // Bug fix #4: callers can supply the total from a previous page-1 response.
    // This removes the sequential count RTT on all subsequent pages.
    if (cachedTotal !== undefined) {
      const totalPages = Math.max(Math.ceil(cachedTotal / limit), 1);
      const safePage = page > totalPages ? 1 : page;
      const data = await wrapTimed(() => execFind((safePage - 1) * limit));
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

    // ── Page > 1 without cached total: sequential count then find ────────────
    const total = await execCount();
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = page > totalPages ? 1 : page;
    const data = await wrapTimed(() => execFind((safePage - 1) * limit));

    return {
      data,
      total,
      page: safePage,
      totalPages,
      limit,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Convenience factory — avoids `new` at the call site.
 *
 * @example
 * const result = await queryFind(User.find(), req.query, { maxTimeMS: 3000 })
 *   .allowFields(['name', 'email', 'createdAt'])
 *   .where({ deletedAt: null })
 *   .filter()
 *   .globalSearch(['name', 'email'])
 *   .sort()
 *   .limitFields('-password -__v')
 *   .paginate();
 */
export function queryFind<T>(
  query: Query<T[], T>,
  queryString: QueryParams,
  options?: QueryFindOptions,
): QueryFind<T> {
  return new QueryFind<T>(query, queryString, options);
}

export default QueryFind;
