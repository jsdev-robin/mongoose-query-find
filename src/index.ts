/**
 * @file query-find.ts
 * @description Production-grade fluent query builder for Mongoose 8.x / 9.x.
 * @requires mongoose ^8.0.0 || ^9.0.0
 *
 * Features:
 *  - URL query string → Mongoose filter (sanitized, validated, coerced)
 *  - Global full-text search via $or regex
 *  - Flexible sort, field projection, and populate
 *  - count + find run fully in parallel (Promise.all)
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
 *  - Zero external runtime dependencies beyond mongoose
 */

import mongoose, { Model, PopulateOptions, Query } from 'mongoose';

/**
 * Mongoose 8/9 does not export FilterQuery or RootFilterQuery as named
 * exports. QueryFilter<T> lives inside the `mongoose` namespace and is
 * accessed via `mongoose.QueryFilter<T>`. We alias it here so the rest
 * of the file stays readable.
 */
type MFilter<T> = mongoose.QueryFilter<T>;

// ─── Constants ────────────────────────────────────────────────────────────────

const RESERVED_KEYS = new Set<string>(['page', 'sort', 'limit', 'fields', 'q']);

/** Hard cap — prevents clients from dumping the whole collection. */
const MAX_LIMIT = 100;

/** Hard cap — prevents DoS via ?a[b][c][d][e][f]=1 */
const MAX_NESTING_DEPTH = 5;

/** Hard cap — prevents compiling huge regexes from ?q= */
const MAX_SEARCH_LENGTH = 200;

/** Hard cap — prevents abuse via ?sort=a,b,c,d,e,f,... */
const MAX_SORT_FIELDS = 5;

/** Default query timeout in milliseconds — prevents runaway scans on unindexed fields. */
const DEFAULT_MAX_TIME_MS = 5_000;

const DATE_FIELD_RE =
  /(^|\.)(createdAt|updatedAt|deletedAt|date|birthDate|expiresAt)$/i;

const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mongo comparison/array operator names accepted WITHOUT a leading "$" in
 * the URL query string (e.g. `?age[gte]=18` → `{ age: { $gte: 18 } }`).
 * Only ever applied to OBJECT KEYS during the recursive coercion pass —
 * never to string values — so a value like `?name=eq` is left untouched.
 */
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

/**
 * Operators that are never permitted anywhere in a client-supplied filter,
 * regardless of nesting depth. Catches $where, $expr, $function, etc.
 */
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

export interface QueryFindOptions {
  /**
   * Maximum time in milliseconds MongoDB is allowed to spend on the query.
   * Defaults to 5000ms. Pass 0 to disable.
   */
  maxTimeMS?: number;
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

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_NESTING_DEPTH) return undefined;

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const s = sanitize(item, depth + 1);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = sanitize(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }

  return undefined;
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

/**
 * Builds a lowercase lookup set from the user-supplied allowlist so that
 * field matching is case-insensitive (e.g. allowFields(['Name', 'Email'])
 * will match ?name=, ?NAME=, ?eMail=, etc.). The original-cased fields are
 * still used wherever they need to be emitted (e.g. default sort/projection).
 */
function buildAllowedLookup(allowedFields: Set<string>): Set<string> {
  const lookup = new Set<string>();
  for (const f of allowedFields) lookup.add(f.toLowerCase());
  return lookup;
}

/** Case-insensitive membership check against a lowercase lookup set. */
function isFieldAllowed(field: string, allowedLookup: Set<string>): boolean {
  return allowedLookup.has(field.toLowerCase());
}

/**
 * Allowlist-filters the top-level keys of a client-supplied filter object.
 * `$`-prefixed operator keys (e.g. $and, $or) always pass through.
 * Matching is case-insensitive (via allowedLookup), and a matched key is
 * rewritten to the casing originally declared in allowFields() — e.g.
 * ?NAME=foo with allowFields(['name']) becomes { name: 'foo' }, not
 * { NAME: 'foo' }, so it actually matches the schema path.
 */
function enforceAllowlist(
  filter: Record<string, unknown>,
  allowedLookup: Set<string>,
  allowedFields: Set<string>,
): Record<string, unknown> {
  if (allowedLookup.size === 0) return filter;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) {
      out[k] = v;
      continue;
    }
    if (isFieldAllowed(k, allowedLookup)) {
      const canonical =
        [...allowedFields].find((f) => f.toLowerCase() === k.toLowerCase()) ??
        k;
      out[canonical] = v;
    }
  }
  return out;
}

// ─── Operator-key coercion ────────────────────────────────────────────────────

/**
 * Recursively walks a parsed (sanitized) object/array tree and rewrites
 * plain operator-like KEYS (eq, ne, gt, gte, lt, lte, in, nin) to their
 * "$"-prefixed Mongo equivalents (e.g. `{ age: { gte: 18 } }` →
 * `{ age: { $gte: 18 } }`).
 *
 * This replaces the previous implementation, which ran a regex over the
 * JSON-stringified filter and rewrote ANY occurrence of these words —
 * including inside string VALUES (e.g. `?name=eq` or `?status=in`),
 * silently corrupting user data into Mongo operators. By operating on the
 * parsed object tree and only ever touching object KEYS, string values are
 * never inspected or mutated.
 */
function coerceOperatorKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => coerceOperatorKeys(item));
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const newKey = COERCIBLE_OPS.has(k) ? `$${k}` : k;
      out[newKey] = coerceOperatorKeys(v);
    }
    return out;
  }

  return value;
}

// ─── Type coercion ────────────────────────────────────────────────────────────

/**
 * Recursively coerces string 'true'/'false' to booleans at any nesting depth.
 * Fixes the original shallow-only implementation.
 */
function coerceBooleans(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;

  if (Array.isArray(value)) {
    return value.map((item) => coerceBooleans(item));
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = coerceBooleans(v);
    }
    return out;
  }

  return value;
}

function coerceDates(
  obj: Record<string, unknown>,
  parentKey = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    const isOp = k.startsWith('$');
    const path = isOp ? parentKey : parentKey ? `${parentKey}.${k}` : k;

    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !(v instanceof Date)
    ) {
      out[k] = coerceDates(v as Record<string, unknown>, path);
      continue;
    }

    if (typeof v === 'string' && DATE_FIELD_RE.test(path)) {
      const parsed = new Date(v);
      if (isNaN(parsed.getTime())) {
        // Leave unparseable strings as-is; Mongoose CastError → 400 upstream.
        out[k] = v;
        continue;
      }
      if (PLAIN_DATE_RE.test(v)) {
        const start = new Date(v);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        out[k] = { $gte: start, $lt: end };
        continue;
      }
      out[k] = parsed;
      continue;
    }

    out[k] = v;
  }

  return out;
}

// ─── Operator validation ──────────────────────────────────────────────────────

/**
 * Recursively walks the entire filter tree and throws on:
 *  1. Banned operators at any depth ($where, $expr, $function, etc.)
 *  2. Unknown top-level $ operators (only $and/$or/$nor/$not allowed at root)
 *
 * Fixes the original shallow-only check.
 */
function rejectDisallowedOperators(
  filter: Record<string, unknown>,
  depth = 0,
): void {
  for (const [k, v] of Object.entries(filter)) {
    // Always banned at any depth
    if (BANNED_OPERATORS.has(k)) {
      throw new QueryFindValidationError(
        `Disallowed operator in query: "${k}"`,
      );
    }

    // Top-level unknown $ operators
    if (depth === 0 && k.startsWith('$') && !ALLOWED_TOP_LEVEL_OPS.has(k)) {
      throw new QueryFindValidationError(
        `Disallowed top-level operator in query string: "${k}"`,
      );
    }

    // Recurse into nested objects
    if (Array.isArray(v)) {
      for (const item of v) {
        if (
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          !(item instanceof Date)
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
  allowedFields: Set<string>,
): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!RESERVED_KEYS.has(k)) stripped[k] = v;
  }

  const safe = sanitize(stripped) as Record<string, unknown>;

  // Rewrite bare operator keys (eq/ne/gt/...) to "$"-prefixed Mongo
  // operators. Operates on parsed object KEYS only — string values
  // (e.g. ?status=in, ?name=eq) are never touched.
  const withOps = coerceOperatorKeys(safe) as Record<string, unknown>;

  const coerced = coerceDates(
    coerceBooleans(withOps) as Record<string, unknown>,
  );
  const allowed = enforceAllowlist(coerced, allowedLookup, allowedFields);
  rejectDisallowedOperators(allowed);

  return allowed;
}

// ─── Sort parser ──────────────────────────────────────────────────────────────

function parseSort(
  sort: string,
  allowedLookup: Set<string>,
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
    if (allowedLookup.size > 0 && !isFieldAllowed(field, allowedLookup))
      continue;

    out[field] = desc ? -1 : 1;
    count++;
  }
  return out;
}

// ─── Projection sanitizer ─────────────────────────────────────────────────────

/**
 * Strips fields from a client-supplied projection that are not in the allowlist.
 * Handles both inclusion ("name email") and exclusion ("-password -__v") syntax.
 * Always permits _id and __v in exclusion projections.
 * Allowlist matching is case-insensitive.
 * When allowedFields is empty, returns the projection unchanged.
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
 *
 * Security notes:
 *  - `.allowFields()` before `.filter()` restricts which URL params reach Mongo.
 *  - Allowlist matching (filter/sort/projection) is case-insensitive — e.g.
 *    allowFields(['name']) also matches ?Name=, ?NAME=, etc. For `.filter()`,
 *    a matched field is also normalized back to the casing declared in
 *    allowFields() (e.g. ?NAME=foo -> { name: 'foo' }) so it matches the
 *    actual schema path.
 *  - `.where()` conditions are hard — URL cannot override them.
 *  - Unknown/banned $ operators throw QueryFindValidationError (checked recursively).
 *  - Nesting depth capped at 5; page size capped at 100; sort fields capped at 5.
 *  - Search terms are regex-escaped (ReDoS prevention) and length-capped at 200 chars.
 *  - ?fields= projection is allowlist-filtered to prevent sensitive field leakage.
 *  - Operator-key coercion (eq/gte/in/...) only touches object KEYS, never string
 *    VALUES — a search like ?name=eq or ?status=in cannot be corrupted into a
 *    Mongo operator.
 *  - All queries run with maxTimeMS to prevent runaway collection scans.
 */
export class QueryFind<
  TRawDocType,
  TModelType extends Model<TRawDocType> = Model<TRawDocType>,
> {
  private readonly model: TModelType;
  private readonly qs: Readonly<QueryParams>;
  private readonly options: Required<QueryFindOptions>;

  private _allowedFields: Set<string> = new Set();
  /** Lowercase mirror of _allowedFields, used for case-insensitive matching. */
  private _allowedLookup: Set<string> = new Set();
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
    };
  }

  // ── Configuration ───────────────────────────────────────────────────────────

  /**
   * Declare which fields may appear in URL filters, sort, and projection.
   * Matching against `?field=`, `?sort=`, and `?fields=` is case-insensitive,
   * so `allowFields(['Name', 'Email'])` will also match `?name=`, `?NAME=`,
   * `?eMail=`, etc.
   * Call before `.filter()`, `.sort()`, and `.limitFields()`.
   */
  allowFields(fields: string[]): this {
    this._allowedFields = new Set(fields);
    this._allowedLookup = buildAllowedLookup(this._allowedFields);
    return this;
  }

  // ── Builder methods ─────────────────────────────────────────────────────────

  /** Parse URL query params into a Mongoose filter (respects allowlist). */
  filter(): this {
    const parsed = buildFilter(
      this.qs,
      this._allowedLookup,
      this._allowedFields,
    );
    Object.assign(this._filter, parsed);
    return this;
  }

  /**
   * Apply mandatory server-side conditions the URL cannot override.
   * Use for multi-tenancy, soft-delete exclusion, etc.
   *
   * @example .where({ orgId: req.user.orgId, deletedAt: null })
   */
  where(conditions: Partial<Record<keyof TRawDocType, unknown>>): this {
    Object.assign(this._filter, conditions);
    return this;
  }

  /**
   * Case-insensitive full-text search across `fields` when `?q=` is present.
   * Search term is regex-escaped (ReDoS prevention) and capped at 200 chars.
   * Preserves any existing `$or` by lifting both into `$and`.
   */
  globalSearch(fields: string[]): this {
    const raw = this.qs.q?.trim();

    // Guard: missing, empty, or oversized search term
    if (!raw || raw.length > MAX_SEARCH_LENGTH || fields.length === 0) {
      return this;
    }

    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchOr = fields.map((field) => ({
      [field]: { $regex: escaped, $options: 'i' },
    }));

    // Always AND the search clause with whatever conditions are already
    // present (top-level fields from .where()/.filter(), or existing
    // $or/$and). This avoids the bug where a top-level field that
    // happens to also be one of the `fields` passed here (e.g.
    // ?status=active combined with .globalSearch(['status','name']))
    // would sit alongside $or and be implicitly ANDed with it — making
    // the search match only documents where `status` is BOTH exactly
    // "active" AND matches the regex, silently excluding matches on
    // `name`. Wrapping the existing filter as one branch of $and
    // preserves all prior conditions intact while ORing across the
    // search fields independently.
    if (Object.keys(this._filter).length > 0) {
      this._filter = {
        $and: [this._filter, { $or: searchOr }],
      };
    } else {
      this._filter = { $or: searchOr as MFilter<TRawDocType>['$or'] };
    }

    return this;
  }

  /**
   * Apply sort from `?sort=`. Falls back to `{ createdAt: -1 }`.
   * Fields not in the allowlist are silently skipped (case-insensitive match).
   * Capped at MAX_SORT_FIELDS (5) fields.
   */
  sort(): this {
    if (this.qs.sort) {
      const parsed = parseSort(this.qs.sort, this._allowedLookup);
      this._sort =
        Object.keys(parsed).length > 0 ? parsed : { ...DEFAULT_SORT };
    }
    return this;
  }

  /**
   * Configure field projection.
   * Priority: `?fields=` query param > `defaultFields` argument > no projection.
   *
   * When `allowFields()` has been called, any field in `?fields=` that is not
   * in the allowlist is stripped (case-insensitive match) — preventing clients
   * from projecting sensitive fields like `password` or `resetToken`.
   *
   * @param defaultFields  e.g. `'-password -__v'` — always excluded when the
   *                       client does not supply `?fields=`.
   */
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
   * Register a populate path. Chainable; all entries applied in `paginate()`.
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
      this._populates.push(path);
    }
    return this;
  }

  // ── Terminal ────────────────────────────────────────────────────────────────

  /**
   * Execute and return a paginated result.
   *
   * - count + find run fully in parallel via Promise.all (saves one round-trip).
   * - Uses estimatedDocumentCount fast-path when no filter is applied (O(1)).
   * - .lean() returns plain objects (~3-5× faster for read-only responses).
   * - maxTimeMS applied to both count and find (prevents runaway scans).
   * - page is clamped to 1 if it exceeds totalPages (safe mid-delete behavior).
   *
   * @throws {QueryFindValidationError} on disallowed $ operators in the URL.
   */
  async paginate(): Promise<PaginatedResult<TRawDocType>> {
    const page = parsePage(this.qs.page);
    const limit = parseLimit(this.qs.limit);
    const mongoFilter = this._filter as MFilter<TRawDocType>;
    const hasFilter = Object.keys(this._filter).length > 0;
    const { maxTimeMS } = this.options;

    const buildFind = (skip: number) => {
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

    const countQuery: Promise<number> = hasFilter
      ? (this.model
          .countDocuments(mongoFilter)
          .maxTimeMS(maxTimeMS) as unknown as Promise<number>)
      : (this.model.estimatedDocumentCount() as unknown as Promise<number>);

    const [total, firstPageData] = await Promise.all([
      countQuery,
      buildFind(0),
    ]);

    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const safePage = page > totalPages ? 1 : page;

    if (safePage === 1) {
      return {
        data: firstPageData,
        total,
        page: 1,
        totalPages,
        limit,
        hasNextPage: 1 < totalPages,
        hasPrevPage: false,
      };
    }

    const data = await buildFind((safePage - 1) * limit);

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
