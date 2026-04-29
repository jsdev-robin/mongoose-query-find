import { Model, PopulateOptions, Query, QueryFilter } from 'mongoose';

// ─── Types ────────────────────────────────────────────────────────────────────

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
}

// Reserved keys stripped before building the filter
const RESERVED_KEYS = ['page', 'sort', 'limit', 'fields', 'q'] as const;
type ReservedKey = (typeof RESERVED_KEYS)[number];

// MongoDB comparison operators that need a `$` prefix
const MONGO_OPERATORS_RE = /\b(eq|ne|gt|gte|lt|lte|in|nin)\b/g;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively keep only plain, JSON-serializable values (string, number,
 * boolean, null, plain object, array). Drops anything that is a class
 * instance, function, symbol, or undefined — which prevents circular-
 * reference errors when req.query accidentally contains Mongoose/Express
 * internal objects.
 */
function sanitize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitize).filter((v) => v !== undefined);
  }

  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitize(v);
      if (sanitized !== undefined) {
        result[k] = sanitized;
      }
    }
    return result;
  }

  // Drop class instances, functions, symbols, undefined, etc.
  return undefined;
}

/**
 * Coerce plain string booleans to real booleans so filters like
 * `?isActive=true` work correctly against boolean schema fields.
 */
function coerceBooleans(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      if (v === 'true') return [k, true];
      if (v === 'false') return [k, false];
      return [k, v];
    }),
  );
}

// Field names (or suffixes) that should be treated as dates
const DATE_FIELD_RE = /(^|\.)(createdAt|updatedAt|deletedAt|date|Date)$/;

/**
 * Recursively walk the filter object and coerce any string value stored
 * under a date-like key into a proper `Date` instance.
 *
 * Handles both plain strings and MongoDB operator objects, e.g.:
 *   ?createdAt=2024-01-01          → { createdAt: { $gte: Date, $lt: Date } }
 *   ?createdAt[$gte]=2024-01-01    → { createdAt: { $gte: Date } }
 */
function coerceDates(
  obj: Record<string, unknown>,
  parentKey = '',
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      const path = parentKey ? `${parentKey}.${k}` : k;

      // Recurse into nested operator objects (e.g. { $gte: '...' })
      if (
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        !(v instanceof Date)
      ) {
        const nested = coerceDates(v as Record<string, unknown>, path);
        return [k, nested];
      }

      // Coerce string → Date when key matches a date field pattern
      if (typeof v === 'string' && DATE_FIELD_RE.test(path)) {
        const parsed = new Date(v);
        if (isNaN(parsed.getTime())) return [k, v];

        // If it's a plain date string (no time component), convert to a
        // $gte/$lt range so it matches all documents within that day.
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
          const start = new Date(v);
          const end = new Date(start);
          end.setUTCDate(end.getUTCDate() + 1);
          return [k, { $gte: start, $lt: end }];
        }

        return [k, parsed];
      }

      return [k, v];
    }),
  );
}

/**
 * Parse the raw query string into a Mongoose-compatible filter object.
 * Strips reserved keys, sanitizes all values to plain JSON-safe types,
 * and rewrites bare operator names (gt → $gt, etc.).
 */
function buildFilterFromQueryString(raw: QueryParams): Record<string, unknown> {
  // Strip reserved keys first
  const stripped = Object.fromEntries(
    Object.entries(raw).filter(
      ([k]) => !RESERVED_KEYS.includes(k as ReservedKey),
    ),
  );

  // Sanitize to plain values only — prevents circular JSON errors
  const safe = sanitize(stripped) as Record<string, unknown>;

  // Rewrite bare operator names to MongoDB $ operators
  const withOperators = JSON.parse(
    JSON.stringify(safe).replace(MONGO_OPERATORS_RE, (m) => `$${m}`),
  ) as Record<string, unknown>;

  return coerceDates(coerceBooleans(withOperators));
}

/**
 * Parse a comma-separated sort string (e.g. `-createdAt,name`) into a
 * `{ field: 1 | -1 }` map.
 */
function parseSortString(sort: string): Record<string, 1 | -1> {
  return Object.fromEntries(
    sort.split(',').map((f) => (f.startsWith('-') ? [f.slice(1), -1] : [f, 1])),
  ) as Record<string, 1 | -1>;
}

// ─── QueryFind ────────────────────────────────────────────────────────────────

/**
 * Fluent query builder that progressively refines a Mongoose query,
 * then paginates the result using two native `countDocuments` + `find` calls
 * (no aggregation pipeline required).
 *
 * @example
 * const result = await new QueryFind(Model.find(), req.query)
 *   .filter()
 *   .globalFilter(['name', 'email'])
 *   .sort()
 *   .limitFields('-__v')
 *   .populate('author')
 *   .populate({ path: 'comments', select: 'text createdAt' })
 *   .paginate();
 */
class QueryFind<
  TRawDocType,
  TModelType extends Model<TRawDocType> = Model<TRawDocType>,
> {
  private readonly model: TModelType;
  private readonly queryString: QueryParams;

  /** Accumulated Mongoose filter (populated by `filter()` and `globalFilter()`). */
  private filterQuery: Record<string, unknown> = {};

  /** Sort order applied in `paginate()`. */
  private sortQuery: Record<string, 1 | -1> = { createdAt: -1 };

  /** Projection string applied in `paginate()`. */
  private selectQuery: string | null = null;

  /** Accumulated populate options — each call to `populate()` appends here. */
  private populateOptions: PopulateOptions[] = [];

  constructor(
    query: Query<TRawDocType[], TRawDocType>,
    queryString: QueryParams,
  ) {
    this.model = query.model as unknown as TModelType;
    this.queryString = queryString;
  }

  // ── Builder methods ─────────────────────────────────────────────────────────

  /** Parse the URL query string into a Mongoose filter. */
  filter(): this {
    const parsed = buildFilterFromQueryString(this.queryString);
    this.filterQuery = {
      ...this.filterQuery,
      ...(parsed as QueryFilter<TRawDocType>),
    };
    return this;
  }

  /**
   * Add a case-insensitive `$or` regex search across the supplied fields
   * when the query string contains a `q` parameter.
   */
  globalFilter(fields: string[]): this {
    const search = this.queryString.q;
    if (search && fields.length > 0) {
      this.filterQuery.$or = fields.map((field) => ({
        [field]: { $regex: search, $options: 'i' },
      })) as QueryFilter<TRawDocType>['$or'];
    }
    return this;
  }

  /**
   * Configure sort order from the `sort` query param.
   * Falls back to `{ createdAt: -1 }` when the param is absent.
   */
  sort(): this {
    if (this.queryString.sort) {
      this.sortQuery = parseSortString(this.queryString.sort);
    }
    return this;
  }

  /**
   * Configure field projection.
   *
   * Priority order:
   *   1. `?fields=` query param (always wins when present).
   *   2. `defaultFields` argument (used as fallback when no query param).
   *   3. No projection at all when both are absent (all fields returned).
   *
   * @param defaultFields - Optional space- or comma-separated projection
   *   string, e.g. `'-password -__v'`. Omit to rely solely on the
   *   `?fields=` query param.
   */
  limitFields(defaultFields?: string): this {
    if (this.queryString.fields) {
      this.selectQuery = this.queryString.fields.split(',').join(' ');
    } else if (defaultFields) {
      this.selectQuery = defaultFields;
    }
    return this;
  }

  /**
   * Register a populate directive. Can be called multiple times to populate
   * multiple paths — each call appends to the internal list.
   *
   * Accepts the same arguments as Mongoose's own `.populate()`:
   *   - A plain path string:            `.populate('author')`
   *   - A path + select string:         `.populate('author', 'name email')`
   *   - A full `PopulateOptions` object: `.populate({ path: 'comments', select: 'text', match: { visible: true } })`
   *
   * All registered populates are applied inside `paginate()` after the
   * `find` query is built — core filter / sort / pagination logic is
   * completely untouched.
   *
   * @param path   - Field path to populate, or a full `PopulateOptions` object.
   * @param select - Optional field projection for the populated documents
   *                 (only used when `path` is a plain string).
   */
  populate(path: string | PopulateOptions, select?: string): this {
    if (typeof path === 'string') {
      const opt: PopulateOptions = { path };
      if (select) opt.select = select;
      this.populateOptions.push(opt);
    } else {
      this.populateOptions.push(path);
    }
    return this;
  }

  // ── Terminal method ─────────────────────────────────────────────────────────

  /**
   * Execute the query and return a paginated result.
   *
   * Two database round-trips are made:
   *   1. `countDocuments` with the current filter — O(index scan).
   *   2. `find` with filter, sort, skip, limit, projection, and any
   *      registered populates.
   *
   * If the requested page exceeds `totalPages` (e.g. after a deletion),
   * page 1 is returned instead so the caller always receives valid data.
   */
  async paginate(): Promise<PaginatedResult<TRawDocType>> {
    const page = Math.max(parseInt(this.queryString.page ?? '1', 10), 1);
    const limit = Math.max(parseInt(this.queryString.limit ?? '10', 10), 1);

    // ── 1. Count matching documents ────────────────────────────────────────
    const total = await this.model.countDocuments(this.filterQuery);

    const totalPages = Math.ceil(total / limit) || 1;
    const safePage = page > totalPages ? 1 : page;
    const skip = (safePage - 1) * limit;

    // ── 2. Fetch the page ──────────────────────────────────────────────────
    const findQuery = this.model
      .find(this.filterQuery)
      .sort(this.sortQuery)
      .skip(skip)
      .limit(limit);

    if (this.selectQuery) {
      findQuery.select(this.selectQuery);
    }

    // ── 3. Apply populates (if any) ────────────────────────────────────────
    for (const opt of this.populateOptions) {
      findQuery.populate(opt);
    }

    const data = await findQuery.exec();

    return {
      data: data as TRawDocType[],
      total,
      page: safePage,
      totalPages,
      limit,
    };
  }
}

export default QueryFind;
