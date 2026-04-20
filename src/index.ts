import { Model, Query, QueryFilter } from 'mongoose';

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

/**
 * Parse the raw query string into a Mongoose-compatible filter object.
 * Strips reserved keys and rewrites bare operator names (gt → $gt, etc.).
 */
function buildFilterFromQueryString(raw: QueryParams): Record<string, unknown> {
  const queryObj = Object.fromEntries(
    Object.entries(raw).filter(
      ([k]) => !RESERVED_KEYS.includes(k as ReservedKey),
    ),
  );

  const withOperators = JSON.parse(
    JSON.stringify(queryObj).replace(MONGO_OPERATORS_RE, (m) => `$${m}`),
  ) as Record<string, unknown>;

  return coerceBooleans(withOperators);
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
 *   .paginate();
 */
class QueryFind<
  TRawDocType,
  TModelType extends Model<TRawDocType> = Model<TRawDocType>,
> {
  private readonly model: TModelType;
  private readonly queryString: QueryParams;

  /** Accumulated Mongoose filter (populated by `filter()` and `globalFilter()`). */
  private filterQuery: QueryFilter<TRawDocType> = {};

  /** Sort order applied in `paginate()`. */
  private sortQuery: Record<string, 1 | -1> = { createdAt: -1 };

  /** Projection string applied in `paginate()`. */
  private selectQuery: string | null = null;

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
   * Uses the `fields` query param when present, otherwise falls back to
   * `defaultFields`.
   *
   * @param defaultFields - A space- or comma-separated projection string,
   *   e.g. `'-password -__v'`.
   */
  limitFields(defaultFields: string): this {
    this.selectQuery = this.queryString.fields
      ? this.queryString.fields.split(',').join(' ')
      : defaultFields;
    return this;
  }

  // ── Terminal method ─────────────────────────────────────────────────────────

  /**
   * Execute the query and return a paginated result.
   *
   * Two database round-trips are made:
   *   1. `countDocuments` with the current filter — O(index scan).
   *   2. `find` with filter, sort, skip, limit, and projection.
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
