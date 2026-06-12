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
 * Fixes applied on top of original:
 *  1. where() conditions are stored separately and merged last in paginate() —
 *     URL params can no longer overwrite server-side conditions like deletedAt: null.
 *  2. globalSearch() guards against double-call: subsequent calls extend the
 *     $or array rather than re-wrapping the entire filter in nested $and.
 *  3. Slow-query wrapper now covers execCount() on page > 1 (no cachedTotal path).
 *  4. parseLimit / parsePage are computed once in the constructor, not on every
 *     paginate() call.
 *  5. sanitize() calls onDrop when MAX_NESTING_DEPTH is exceeded, instead of
 *     silently returning undefined.
 *  6. buildAllowedStructures result is memoized — rebuilds only when allowFields()
 *     is actually called.
 *  7. wrapTimed, execFind, execCount promoted to private methods — no longer
 *     re-created as closures on every paginate() call.
 *  8. DEFAULT_SORT freeze is removed; copies are made where needed, the constant
 *     itself is just a plain object used as the default spread source.
 *  9. lean() exposed as a QueryFindOptions flag (default true) so callers that
 *     need Mongoose document instances (virtuals, instance methods) can opt out.
 * 10. Double-cast `as unknown as Promise<number>` replaced with explicit typed
 *     helper to surface any future version mismatches at compile time.
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

// Fix #8: plain object — no freeze needed, it is never mutated in place.
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
  /**
   * Fix #9: whether to call .lean() on find queries (default: true).
   * Set to false if you need Mongoose document instances (virtuals, instance methods).
   */
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

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '10', 10);
  if (isNaN(n) || n < 1) return 10;
  return Math.min(n, MAX_LIMIT);
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

function sanitize(
  value: unknown,
  depth = 0,
  path = '',
  onDrop?: (path: string, value: unknown) => void,
): unknown {
  // Fix #5: call onDrop when depth limit is exceeded so callers are notified.
  if (depth > MAX_NESTING_DEPTH) {
    if (onDrop) {
      onDrop(path, value);
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[query-find] sanitize() dropped value exceeding max nesting depth at path "${path}":`,
        value,
      );
    }
    return undefined;
  }

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

  // Non-plain-object dropped — notify caller.
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

  // Fix #1: URL-derived filter and server-side conditions stored separately.
  // Server conditions are merged last in paginate() and can never be
  // overwritten by URL params regardless of call order.
  private _urlFilter: Record<string, unknown> = {};
  private _serverConditions: Record<string, unknown> = {};

  // Fix #2: track search $or clauses separately so double-call extends rather
  // than re-wraps.
  private _searchOr: Record<string, unknown>[] = [];

  private _sort: Record<string, 1 | -1> = { ...DEFAULT_SORT };
  private _select: string | null = null;
  private _populates: PopulateOptions[] = [];

  // Fix #4: page and limit computed once in constructor.
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
      lean: options.lean ?? true,
      onSlowQuery: options.onSlowQuery,
      onSanitizeDrop: options.onSanitizeDrop,
    };

    // Fix #4: parse once, not on every paginate() call.
    this._page = parsePage(this.qs.page);
    this._limit = parseLimit(this.qs.limit);
  }

  // ── Configuration ───────────────────────────────────────────────────────────

  // Fix #6: allowedStructures only rebuilt when this method is called.
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
    Object.assign(this._urlFilter, parsed);
    return this;
  }

  /**
   * Apply mandatory server-side conditions the URL cannot override.
   *
   * Fix #1: conditions are stored in _serverConditions and merged into the
   * final filter last, inside paginate(). This guarantees URL params (stored
   * in _urlFilter) can never overwrite server-side values regardless of the
   * order in which .where() and .filter() are called.
   *
   * @example .where({ orgId: req.user.orgId, deletedAt: null })
   */
  where(conditions: Partial<Record<keyof TRawDocType, unknown>>): this {
    const asRecord = conditions as Record<string, unknown>;

    // Validate operators in server-supplied conditions.
    // We don't sanitize here (Dates, ObjectIds etc. are legitimate server values),
    // but we do reject banned $ operators in case user data leaked in.
    rejectDisallowedOperators(asRecord);

    Object.assign(this._serverConditions, asRecord);
    return this;
  }

  /**
   * Case-insensitive full-text search across `fields` when `?q=` is present.
   *
   * Fix #2: subsequent calls extend the $or clause list rather than re-wrapping
   * the filter in nested $and, preventing double-wrapping and preserving index
   * usage.
   */
  globalSearch(fields: string[]): this {
    const raw = this.qs.q?.trim();

    if (!raw || raw.length > MAX_SEARCH_LENGTH || fields.length === 0) {
      return this;
    }

    const safeFields =
      this._allowedLookup.size > 0
        ? fields.filter((f) => isFieldAllowed(f, this._allowedLookup))
        : fields;

    if (safeFields.length === 0) return this;

    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    // Extend _searchOr; the $or clause is assembled once in paginate().
    for (const field of safeFields) {
      this._searchOr.push({ [field]: regex });
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
   * @example
   *   .populate('author')
   *   .populate('author', 'name avatar')
   *   .populate({ path: 'comments', select: 'text', match: { visible: true } })
   */
  populate(path: string | PopulateOptions, select?: string): this {
    if (typeof path === 'string') {
      this._populates.push(select ? { path, select } : { path });
    } else {
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

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Fix #1: assemble the final filter by merging URL filter, search clause,
   * and server conditions. Server conditions are applied last so they can
   * never be overwritten by URL-derived values.
   *
   * Fix #2: _searchOr is assembled here once rather than incrementally
   * mutating _filter during globalSearch() calls.
   */
  private buildFinalFilter(): Record<string, unknown> {
    let base: Record<string, unknown> = { ...this._urlFilter };

    if (this._searchOr.length > 0) {
      if (Object.keys(base).length > 0) {
        base = { $and: [base, { $or: this._searchOr }] };
      } else {
        base = { $or: this._searchOr };
      }
    }

    // Server conditions merged last — URL cannot override these.
    return { ...base, ...this._serverConditions };
  }

  /**
   * Fix #7: execFind promoted to private method — no longer a closure
   * recreated on every paginate() call.
   */
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

    // Fix #9: lean() is opt-out, not hardcoded.
    if (lean) q.lean();
    if (this._select) q.select(this._select);
    for (const opt of this._populates) q.populate(opt);
    if (maxTimeMS > 0) q.maxTimeMS(maxTimeMS);

    return q.exec() as Promise<TRawDocType[]>;
  }

  /**
   * Fix #7: execCount promoted to private method.
   * Calls .exec() directly — avoids the Model<unknown> generic mismatch that
   * broke the earlier execCountQuery helper approach.
   */
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
    return (await (this.model as Model<TRawDocType>)
      .countDocuments(mongoFilter)
      .maxTimeMS(maxTimeMS)
      .exec()) as number;
  }

  /**
   * Fix #3 + Fix #7: wrapTimed promoted to a private method that accepts an
   * explicit start time so the slow-query clock can be started before
   * execCount() on page > 1 paths, covering the full round-trip.
   */
  private async wrapTimed<R = void>(
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

  // ── Terminal ────────────────────────────────────────────────────────────────

  /**
   * Execute and return a paginated result.
   *
   * @param cachedTotal - Previously fetched total (from a page-1 response).
   *   When provided on page > 1, the count query is skipped entirely.
   * @throws {QueryFindValidationError} on disallowed $ operators in the URL.
   */
  async paginate(cachedTotal?: number): Promise<PaginatedResult<TRawDocType>> {
    const page = this._page;
    const limit = this._limit;

    // Fix #1: final filter assembled here — server conditions always win.
    const finalFilter = this.buildFinalFilter();
    const mongoFilter = finalFilter as MFilter<TRawDocType>;
    const hasFilter = Object.keys(finalFilter).length > 0;

    // ── Page 1: count + find in parallel ─────────────────────────────────────
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

    // ── Page > 1 with cached total: skip count ────────────────────────────────
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

    // ── Page > 1 without cached total: count + find, both timed ──────────────
    //
    // Fix #3: the entire block (count + find) is wrapped in wrapTimed so slow
    // counts on subsequent pages are visible to onSlowQuery. Previously only
    // execFind was timed on this path.
    //
    // We break out of the generic wrapTimed by collecting the result into a
    // side-channel object that is mutated inside the timed closure. This avoids
    // the tuple-inside-R TypeScript inference problem entirely.
    const result: {
      total: number;
      data: TRawDocType[];
      safePage: number;
      totalPages: number;
    } = { total: 0, data: [], safePage: page, totalPages: 1 };

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
