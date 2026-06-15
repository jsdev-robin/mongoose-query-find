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
 *    ONLY to object keys — never to string values
 *  - estimatedDocumentCount fast-path when no filter is applied
 *  - Query timeout via maxTimeMS (prevents runaway queries)
 *  - Structured error types for clean upstream handling
 *  - Optional cached total for skipping re-count on page > 1
 *  - Optional slow-query hook for observability
 *  - Zero external runtime dependencies beyond mongoose
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

// Never mutated in place — spread into a new object wherever a mutable copy is needed.
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
   * Whether to call .lean() on find queries (default: true).
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

/**
 * Recursively strips non-plain values (class instances, functions, Dates) from
 * an arbitrary object so only JSON-safe primitives and plain objects reach the
 * query pipeline. Notifies the caller via onDrop when values are removed.
 */
function sanitize(
  value: unknown,
  depth = 0,
  path = '',
  onDrop?: (path: string, value: unknown) => void,
): unknown {
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

/**
 * Pre-computes a lowercase lookup set and a canonical-case map from the caller's
 * allowlist. Built once per allowFields() call and reused across all methods.
 */
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
 * Removes any non-operator key from `filter` that is not present in the
 * allowlist. Operator keys (starting with $) are passed through unchanged
 * because they are validated separately by rejectDisallowedOperators().
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

/**
 * Single-pass coercion that handles:
 *  - 'true' / 'false' strings → booleans
 *  - Date-field strings → Date objects (or $gte/$lt range for plain YYYY-MM-DD)
 *  - Shorthand operator keys (eq, ne, gt, …) → prefixed form ($eq, $ne, $gt, …)
 *
 * Operator-key coercion is applied only to object keys, never to string values,
 * preventing accidental rewriting of user-supplied string data.
 */
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

/**
 * Recursively walks a filter object and throws QueryFindValidationError on:
 *  - Any key present in BANNED_OPERATORS (e.g. $where, $expr)
 *  - Any top-level $ key that is not in ALLOWED_TOP_LEVEL_OPS
 *
 * Applied after coercion so shorthand operators have already been prefixed.
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

/**
 * Converts raw URL query params into a safe Mongoose filter by running the
 * full pipeline: strip reserved keys → sanitize → coerce → allowlist → validate.
 */
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
 * Parses a comma-separated sort string (e.g. "-createdAt,name") into a
 * Mongoose sort object. Fields not present in the allowlist are silently
 * skipped. Capped at MAX_SORT_FIELDS to prevent DoS via large sort lists.
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

/**
 * Filters a space-separated projection string against the allowlist.
 * _id and __v are always permitted regardless of the allowlist.
 * Returns an empty string when every token is blocked — callers must handle
 * this case explicitly to avoid accidentally omitting the select() call.
 */
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
 * const result = await new QueryFind(User.find(), req.query)
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

  /**
   * URL-derived filter and server-side conditions are kept separate so that
   * server conditions merged last in paginate() can never be overwritten by
   * URL params, regardless of the order in which where() and filter() are called.
   */
  private _urlFilter: Record<string, unknown> = {};
  private _serverConditions: Record<string, unknown> = {};

  /**
   * $or clauses from globalSearch() are collected here and assembled once
   * inside buildFinalFilter(). This prevents double-call from re-wrapping the
   * entire filter in nested $and.
   */
  private _searchOr: Record<string, unknown>[] = [];

  private _sort: Record<string, 1 | -1> = { ...DEFAULT_SORT };
  private _select: string | null = null;
  private _populates: PopulateOptions[] = [];

  /** Stored so limitFields() can fall back to it when ?fields= is fully blocked. */
  private _defaultFields: string | null = null;

  /** Parsed once in the constructor — not recomputed on every paginate() call. */
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

    this._page = parsePage(this.qs.page);
    this._limit = parseLimit(this.qs.limit);
  }

  // ── Configuration ───────────────────────────────────────────────────────────

  /**
   * Declares which fields the client is permitted to filter, sort, and select.
   * Must be called before filter(), sort(), and limitFields() to take effect.
   * Matching is case-insensitive: allowFields(['Name']) accepts ?name=, ?NAME=.
   *
   * @example .allowFields(['basicInfo.name', 'pricing.base', 'status'])
   */
  allowFields(fields: string[]): this {
    this._allowedFields = new Set(fields);
    const { lookup, canonical } = buildAllowedStructures(this._allowedFields);
    this._allowedLookup = lookup;
    this._canonicalMap = canonical;
    return this;
  }

  // ── Builder methods ─────────────────────────────────────────────────────────

  /**
   * Parses URL query params into a Mongoose filter and merges them into the
   * URL-derived filter store. Only fields present in allowFields() pass through.
   * Reserved keys (page, sort, limit, fields, q) are always stripped first.
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
   * Applies mandatory server-side conditions that the client cannot override.
   * Conditions are merged into the final filter after URL-derived values, so
   * they always win regardless of what the client sends.
   *
   * Unlike filter(), values here are not sanitized — ObjectIds, Dates, and
   * other non-plain types are valid. Banned $ operators are still rejected.
   *
   * @example .where({ linkedTo: req.user.orgId, deletedAt: null })
   */
  where(conditions: Partial<Record<keyof TRawDocType, unknown>>): this {
    const asRecord = conditions as Record<string, unknown>;
    rejectDisallowedOperators(asRecord);
    Object.assign(this._serverConditions, asRecord);
    return this;
  }

  /**
   * Enables case-insensitive full-text search across the given fields when
   * ?q= is present in the query string. Fields not in allowFields() are
   * silently skipped. Safe to call multiple times — subsequent calls extend
   * the $or clause list rather than re-wrapping the filter.
   *
   * @example .globalSearch(['basicInfo.name', 'basicInfo.sku'])
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

    for (const field of safeFields) {
      this._searchOr.push({ [field]: regex });
    }

    return this;
  }

  /**
   * Parses the ?sort= query param into a Mongoose sort object. Fields not in
   * allowFields() are silently dropped. Falls back to DEFAULT_SORT when the
   * parsed result is empty. Capped at MAX_SORT_FIELDS entries.
   *
   * Prefix a field with - for descending order: ?sort=-createdAt,name
   */
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

  /**
   * Controls which fields are returned by the query.
   *
   * When ?fields= is present in the URL, the value is parsed as a
   * comma-separated list and filtered through the allowlist. Only fields
   * declared in allowFields() will be included in the projection.
   *
   * When ?fields= is absent, `defaultFields` is used as-is (no allowlist
   * filtering) — this is the server-controlled default projection.
   *
   * When ?fields= is present but every requested field is blocked by the
   * allowlist, the projection falls back to `defaultFields` rather than
   * omitting select() entirely (which would return all fields).
   *
   * @param defaultFields - Space-separated Mongoose projection string used
   *   when the client does not specify ?fields=.
   *   Example: 'basicInfo.name pricing.base status -__v'
   */
  limitFields(defaultFields?: string): this {
    if (defaultFields) {
      this._defaultFields = defaultFields;
    }

    if (this.qs.fields) {
      const raw = this.qs.fields
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
        .join(' ');
      const sanitized = sanitizeProjection(raw, this._allowedLookup);

      // sanitizeProjection returns an empty string when every requested field
      // is blocked. An empty string is falsy — passing it to select() would
      // silently skip the call and return all fields. Fall back to the
      // server-supplied default projection to prevent unintended field exposure.
      this._select = sanitized || this._defaultFields || null;
    } else if (defaultFields) {
      this._select = defaultFields;
    }

    return this;
  }

  /**
   * Registers a populate path to be applied on the find query.
   * populate.match conditions are sanitized and validated like any other filter.
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
   * Assembles the final Mongoose filter from three sources in priority order:
   *   1. URL-derived filter (lowest priority — client controlled)
   *   2. Global search $or clause
   *   3. Server conditions (highest priority — cannot be overridden by client)
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

    return { ...base, ...this._serverConditions };
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

  /**
   * Uses estimatedDocumentCount when no filter is active for a fast O(1) count.
   * Falls back to countDocuments when a filter is present.
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
   * Wraps an async operation with slow-query detection. When onSlowQuery is
   * provided and the operation exceeds slowQueryThresholdMS, the hook is called
   * with timing and query metadata for observability.
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
   * Executes the query and returns a paginated result.
   *
   * On page 1, count and find run in parallel via Promise.all.
   * On subsequent pages, pass the previously returned `total` as `cachedTotal`
   * to skip the count query entirely.
   *
   * @param cachedTotal - Total document count from a prior page-1 response.
   *   When provided, the countDocuments call is skipped for this request.
   *
   * @throws {QueryFindValidationError} when the URL contains a disallowed $ operator.
   */
  async paginate(cachedTotal?: number): Promise<PaginatedResult<TRawDocType>> {
    const page = this._page;
    const limit = this._limit;

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
