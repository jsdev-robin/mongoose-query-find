# mongoose-query-find

[![npm version](https://img.shields.io/npm/v/mongoose-query-find)](https://www.npmjs.com/package/mongoose-query-find)
[![license](https://img.shields.io/npm/l/mongoose-query-find)](https://github.com/jsdev-robin/mongoose-query-find/blob/main/LICENSE)
[![mongoose peer](https://img.shields.io/badge/mongoose-%5E8%20%7C%7C%20%5E9-brightgreen)](https://mongoosejs.com)

Three fluent, chainable, allowlisted query builders for Mongoose — **`QueryFind`** for simple `Model.find()` queries, **`QueryAggregate`** for anything that needs joins, grouping, timezone-aware date filtering, or advanced pagination, and **`QueryAnalytics`** for dashboards and reporting (time series, cohorts, funnels, sessionization, and more). All three are driven directly from URL query parameters with zero boilerplate.

---

## Table of Contents

**QueryFind**

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Constructor](#constructor)
- [Builder Methods](#builder-methods)
  - [.allowFields()](#allowfieldsfields-string)
  - [.filter()](#filter)
  - [.where()](#whereconditions)
  - [.globalSearch()](#globalsearchfields-string)
  - [.sort()](#sort)
  - [.limitFields()](#limitfieldsdefaultfields-string)
  - [.populate()](#populatepath-string--populateoptions-select-string)
- [Terminal Method](#terminal-method)
  - [.paginate()](#paginate)
- [Query Parameter Reference](#query-parameter-reference)
- [Full Example (Express)](#full-example-express)
- [More Examples](#more-examples)
- [TypeScript Types](#typescript-types)
- [Security](#security)
- [Links](#links)
- [License](#license)

**QueryAggregate**

- [Overview](#queryaggregate-overview)
- [When to use QueryAggregate vs QueryFind](#when-to-use-queryaggregate-vs-queryfind)
- [Installation](#installation-1)
- [Quick Start](#quick-start-1)
- [Constructor & Options](#constructor--options-1)
- [Timezone Handling](#timezone-handling)
- [Builder Methods](#builder-methods-1)
  - [.allowFields()](#allowfieldsfields-string-1)
  - [.dateFields()](#datefieldsfields-string)
  - [.objectIdFields()](#objectidfieldsfields-string)
  - [.filter()](#filter-1)
  - [.where()](#whereconditions-1)
  - [.range()](#rangefield-string-preset-rangepreset)
  - [Custom Range Methods](#custom-range-methods)
    - [.rangeCustomDay()](#rangecustomdayfield-string-date-string)
    - [.rangeBetween()](#rangebetweenfield-string-custom-customdaterangeinput)
    - [.rangeLastNDays()](#rangelastndaysfield-string-days-number)
    - [.rangeLastNHours()](#rangelastnhoursfield-string-hours-number)
    - [.rangeHours()](#rangehoursfield-string-custom-customhourrangeinput)
    - [.rangeCustom()](#rangecustomfield-string-custom-customdatetimerangeinput)
  - [.excludeSoftDeleted()](#excludesoftdeletedfield-deletedat)
  - [.whereIf()](#whereifcondition-conditions)
  - [.globalSearch()](#globalsearchfields-string-1)
  - [.sort()](#sort-1)
  - [.project()](#projectdefaultprojection-string--recordstring-0--1)
  - [.lookup()](#lookupopts-lookupoptions)
  - [.computeField()](#computefieldname-string-expression-unknown)
  - [.addStage()](#addstagestage-pipelinestage)
- [Terminal & Utility Methods](#terminal--utility-methods)
  - [.paginate()](#paginatecachedtotal-number)
  - [.paginateCursor()](#paginatecursoropts-cursorpaginateoptions)
  - [.count()](#count)
  - [.distinct()](#distinctfield-string)
  - [.stats()](#statsspecs-statspec)
  - [.stream()](#stream)
  - [.explain()](#explainverbosity)
  - [.clone()](#clone)
  - [.debugPipeline()](#debugpipeline)
- [Recipes](#recipes)
- [Pipeline Stage Ordering](#pipeline-stage-ordering)
- [Security](#security-1)
- [TypeScript Types](#typescript-types-1)
- [Links](#links-1)
- [License](#license-1)

**QueryAnalytics**

- [Overview](#queryanalytics-overview)
- [When to use QueryAnalytics](#when-to-use-queryanalytics)
- [Installation](#installation-2)
- [Quick Start](#quick-start-2)
- [Constructor & Options](#constructor--options-2)
- [Base Filter Methods](#base-filter-methods)
  - [.match()](#matchconditions)
  - [.dateRange()](#daterangefield-string-range--from-string-to-string-)
  - [.addStage()](#addstagestage-pipelinestage-1)
  - [.clone()](#clone-1)
- [Time Series](#time-series)
  - [.timeSeries()](#timeseriesopts)
  - [.cumulativeSeries()](#cumulativeseriesopts)
- [Comparisons & Breakdowns](#comparisons--breakdowns)
  - [.compare()](#compareopts)
  - [.breakdown()](#breakdownfield-metrics-opts)
  - [.rankedBreakdown()](#rankedbreakdownfield-metrics-opts)
  - [.multiBreakdown()](#multibreakdownfields-metrics-opts)
- [Funnels & Cohorts](#funnels--cohorts)
  - [.funnel()](#funnelsteps)
  - [.cohortRetention()](#cohortretentionopts)
  - [.sessionize()](#sessionizeopts)
- [Statistics](#statistics)
  - [.percentiles()](#percentilesfield-ps)
  - [.stdDevOutliers()](#stddevoutliersfield-opts)
  - [.metrics()](#metricsspecs)
- [Post-Processing Helpers (static)](#post-processing-helpers-static)
  - [QueryAnalytics.movingAverage()](#queryanalyticsmovingaverage)
  - [QueryAnalytics.trend()](#queryanalyticstrend)
  - [QueryAnalytics.forecast()](#queryanalyticsforecast)
- [.heatmap()](#heatmapdatefield-valuefield)
- [Live Updates](#live-updates)
  - [.watch()](#watchonchange-opts)
- [Export & Batch Helpers (static)](#export--batch-helpers-static)
  - [QueryAnalytics.toCSV() / toNDJSON()](#queryanalyticstocsv--tondjson)
  - [QueryAnalytics.dashboard()](#queryanalyticsdashboard)
  - [QueryAnalytics.clearCache()](#queryanalyticsclearcache)
- [Recipes](#recipes-1)
- [Security](#security-2)
- [TypeScript Types](#typescript-types-2)
- [Links](#links-2)
- [License](#license-2)

---

## Installation

```bash
npm install mongoose-query-find
```

```bash
yarn add mongoose-query-find
```

```bash
pnpm add mongoose-query-find
```

> **Peer dependency:** requires `mongoose ^8` or `mongoose ^9` installed in your project.

---

## Quick Start

```ts
import { queryFind } from 'mongoose-query-find';
import UserModel from './models/user';

const result = await queryFind(UserModel.find(), req.query)
  .allowFields(['name', 'email', 'role', 'createdAt'])
  .where({ deletedAt: null })
  .filter()
  .globalSearch(['name', 'email'])
  .sort()
  .limitFields('-password -__v')
  .paginate();
```

`result` will look like:

```json
{
  "data": [...],
  "total": 84,
  "page": 2,
  "totalPages": 9,
  "limit": 10,
  "hasNextPage": true,
  "hasPrevPage": true
}
```

---

## Constructor

```ts
new QueryFind(query, queryString, options?);
// or use the factory function (recommended):
queryFind(query, queryString, options?);
```

| Parameter     | Type                                | Description                                           |
| ------------- | ----------------------------------- | ----------------------------------------------------- |
| `query`       | `Query<TRawDocType[], TRawDocType>` | A Mongoose query, e.g. `Model.find()`                 |
| `queryString` | `QueryParams`                       | The parsed URL query object, e.g. `req.query`         |
| `options`     | `QueryFindOptions` _(optional)_     | Configuration options (see [Options](#options) below) |

### Options

| Option                 | Type                                     | Default     | Description                                                            |
| ---------------------- | ---------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `maxTimeMS`            | `number`                                 | `5000`      | Max milliseconds MongoDB may spend on each query. Pass `0` to disable. |
| `slowQueryThresholdMS` | `number`                                 | `maxTimeMS` | Threshold above which `onSlowQuery` fires.                             |
| `maxLimit`             | `number`                                 | `100`       | Hard cap on `?limit=`.                                                 |
| `lean`                 | `boolean`                                | `true`      | Whether `.find()` calls `.lean()` for faster plain-object reads.       |
| `onSlowQuery`          | `(info: SlowQueryInfo) => void`          | —           | Callback fired when a query exceeds `slowQueryThresholdMS`.            |
| `onSanitizeDrop`       | `(path: string, value: unknown) => void` | —           | Callback fired whenever sanitization drops a client-supplied value.    |

---

## Builder Methods

All builder methods return `this` and are fully chainable. The recommended call order is:

```
allowFields → where → filter → globalSearch → sort → limitFields → populate → paginate
```

---

### `.allowFields(fields: string[])`

Declares which fields may appear in URL filters, sort parameters, and field projections. Acts as an allowlist — any field not listed is silently stripped from client input before it reaches MongoDB.

**Call this before `.filter()`, `.sort()`, and `.limitFields()`.**

```ts
.allowFields(['name', 'email', 'role', 'createdAt'])
```

---

### `.filter()`

Parses the URL query string into a Mongoose filter. Automatically:

- Strips reserved keys (`page`, `limit`, `sort`, `fields`, `q`)
- Converts comparison operator names to MongoDB `$` syntax (`gt` → `$gt`, `lte` → `$lte`, etc.)
- Recursively coerces string booleans to real booleans (`"true"` → `true`, `"false"` → `false`)
- Coerces date-like strings to `Date` instances for fields named `createdAt`, `updatedAt`, `deletedAt`, `date`, `birthDate`, or `expiresAt`
- Recursively validates and rejects banned operators (`$where`, `$expr`, `$function`, etc.)

**Supported operators:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`

```
GET /users?age[gte]=18&isActive=true&role=admin
```

```ts
.filter()
// → { age: { $gte: 18 }, isActive: true, role: 'admin' }
```

---

### `.where(conditions)`

Applies mandatory server-side conditions that the URL **cannot override**. Use this for multi-tenancy, soft-delete exclusion, and any security-critical constraints.

```ts
.where({ orgId: req.user.orgId, deletedAt: null })
```

> `.where()` always wins — conditions are merged after `.filter()` and will overwrite any conflicting URL params.

---

### `.globalSearch(fields: string[])`

Adds a case-insensitive `$or` regex search across the specified fields when the `?q=` query parameter is present. If `q` is absent or exceeds 200 characters, this method is a no-op.

Search terms are regex-escaped to prevent ReDoS attacks.

```
GET /users?q=john
```

```ts
.globalSearch(['name', 'email'])
// → { $or: [{ name: /john/i }, { email: /john/i }] }
```

If a `$or` clause already exists in the filter (e.g. from `.filter()`), both are safely merged under `$and`.

---

### `.sort()`

Applies sort order from the `?sort=` query parameter. Prefix a field with `-` for descending order. Multiple fields are comma-separated, capped at 5 fields.

```
GET /users?sort=-createdAt,name
```

```ts
.sort()
// → sorts by createdAt DESC, then name ASC
```

Defaults to `{ createdAt: -1 }` when the `sort` param is absent. Fields not in the allowlist are silently skipped.

---

### `.limitFields(defaultFields?: string)`

Controls which fields are returned (projection). Uses the `?fields=` query param when present, otherwise falls back to `defaultFields`.

Fields requested via `?fields=` are filtered against the allowlist — clients cannot project sensitive fields like `password` or `resetToken`.

**Priority order:**

1. `?fields=` query param — always wins when present (allowlist-filtered)
2. `defaultFields` argument — used as fallback when no query param
3. No projection when both are absent (all fields returned)

```
GET /users?fields=name,email,role
```

```ts
.limitFields('-password -__v')
// With ?fields=name,email,role  → selects only name, email, role
// Without ?fields               → excludes password and __v
```

---

### `.populate(path: string | PopulateOptions, select?: string)`

Registers a populate directive. Chainable — each call appends to the internal list. All registered populates are applied inside `paginate()`.

Accepts the same arguments as Mongoose's own `.populate()`:

```ts
// Plain path string
.populate('author')

// Path + select string
.populate('author', 'name email')

// Full PopulateOptions object
.populate({ path: 'comments', select: 'text createdAt', match: { visible: true } })

// Multiple calls — fully chainable
.populate('author')
.populate({ path: 'comments', select: 'text createdAt' })
```

---

## Terminal Method

### `.paginate()`

Executes the query and returns a `Promise<PaginatedResult<T>>`.

- `countDocuments` and `find` run **in parallel** via `Promise.all` (saves one network round-trip).
- Uses `estimatedDocumentCount` as a fast-path when no filter is applied (O(1) vs O(n)).
- `.lean()` is applied for ~3–5× faster reads on plain object responses.
- `maxTimeMS` is applied to both count and find to prevent runaway collection scans.
- If the requested `page` exceeds `totalPages` (e.g. after a deletion), page `1` is returned automatically.

```
GET /users?page=2&limit=20
```

**Returns:**

```ts
{
  data: T[];
  total: number;        // Total matching documents across all pages
  page: number;         // Current page (auto-corrects to 1 if out of range)
  totalPages: number;
  limit: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}
```

**Defaults:** `page=1`, `limit=10`, max `limit=100`.

---

## Query Parameter Reference

| Parameter   | Example                   | Description                                            |
| ----------- | ------------------------- | ------------------------------------------------------ |
| `page`      | `?page=3`                 | Page number (default: `1`, min: `1`)                   |
| `limit`     | `?limit=25`               | Documents per page (default: `10`, max: `100`)         |
| `sort`      | `?sort=-createdAt,name`   | Sort fields; prefix `-` for descending (max: 5 fields) |
| `fields`    | `?fields=name,email`      | Comma-separated fields to include in the response      |
| `q`         | `?q=john`                 | Global search term (max: 200 chars)                    |
| _(any key)_ | `?role=admin&age[gte]=18` | Field-level filters processed by `.filter()`           |

---

## Full Example (Express)

```ts
import { Request, Response } from 'express';
import { queryFind } from 'mongoose-query-find';
import UserModel from '../models/user';

export const getUsers = async (req: Request, res: Response) => {
  const result = await queryFind(UserModel.find(), req.query)
    .allowFields(['name', 'email', 'username', 'role', 'isActive', 'createdAt'])
    .where({ orgId: req.user.orgId, deletedAt: null })
    .filter()
    .globalSearch(['name', 'email', 'username'])
    .sort()
    .limitFields('-password -__v')
    .populate('role', 'name permissions')
    .paginate();

  res.json({ status: 'success', ...result });
};
```

**Example requests:**

```bash
# Page 2, 15 per page, only active admins sorted by name
GET /users?page=2&limit=15&role=admin&isActive=true&sort=name

# Search "alice" across name, email, and username
GET /users?q=alice

# Users older than 25, return only name and email
GET /users?age[gt]=25&fields=name,email

# Filter by exact date
GET /users?createdAt=2024-06-01

# Filter by date range
GET /users?createdAt[gte]=2024-01-01&createdAt[lte]=2024-12-31

# Combined: search + filter + sort + pagination
GET /users?q=john&role=editor&sort=-createdAt&page=1&limit=5
```

---

## More Examples

**E-commerce product listing — nested price filters + category populate:**

```ts
export const getProducts = async (req: Request, res: Response) => {
  const result = await queryFind(ProductModel.find(), req.query)
    .allowFields(['name', 'price', 'category', 'inStock', 'brand', 'createdAt'])
    .where({ deletedAt: null, published: true })
    .filter()
    .globalSearch(['name', 'brand'])
    .sort()
    .limitFields('name price inStock brand')
    .populate('category', 'name slug')
    .paginate();

  res.json(result);
};
```

```bash
# Price between $20 and $100, in stock, sorted cheapest first
GET /products?price[gte]=20&price[lte]=100&inStock=true&sort=price

# Search "nike" across name and brand
GET /products?q=nike&sort=-createdAt
```

**Blog posts — multiple populates + logical operators:**

```ts
export const getPosts = async (req: Request, res: Response) => {
  const result = await queryFind(PostModel.find(), req.query)
    .allowFields(['title', 'status', 'authorId', 'tags', 'publishedAt'])
    .where({ deletedAt: null })
    .filter()
    .globalSearch(['title'])
    .sort()
    .limitFields('title status publishedAt')
    .populate('authorId', 'name avatar')
    .populate({
      path: 'comments',
      select: 'text createdAt',
      match: { visible: true },
    })
    .paginate();

  res.json(result);
};
```

```bash
# Published OR featured posts, using the safe top-level $or
GET /posts?$or[0][status]=published&$or[1][featured]=true

# Posts tagged "typescript" published this year
GET /posts?tags=typescript&publishedAt[gte]=2026-01-01
```

**Admin panel — strict field allowlist, sensitive fields never leak:**

```ts
export const adminListUsers = async (req: Request, res: Response) => {
  const result = await queryFind(UserModel.find(), req.query, { maxLimit: 250 })
    .allowFields(['name', 'email', 'role', 'isActive', 'lastLoginAt'])
    .where({ orgId: req.user.orgId })
    .filter()
    .sort()
    .limitFields('-password -passwordResetToken -__v') // client's ?fields= can never override this
    .paginate();

  res.json(result);
};
```

```bash
# Even if a client tries ?fields=password, it's stripped — not in allowFields()
GET /admin/users?fields=password,email&role=admin
```

**Cached count pattern — skip re-counting on subsequent pages:**

```ts
export const getNotifications = async (req: Request, res: Response) => {
  const builder = queryFind(NotificationModel.find(), req.query)
    .allowFields(['userId', 'read', 'createdAt'])
    .where({ userId: req.user.id })
    .filter()
    .sort();

  // First request from the client includes no cachedTotal
  const cachedTotal = req.query.cachedTotal
    ? Number(req.query.cachedTotal)
    : undefined;
  const result = await builder.paginate(cachedTotal);

  res.json(result); // client stores result.total and sends it back as ?cachedTotal= on the next page
};
```

---

## TypeScript Types

All types are exported:

```ts
import {
  queryFind,
  QueryFind,
  QueryParams,
  PaginatedResult,
  QueryFindOptions,
  QueryFindError,
  QueryFindValidationError,
  SlowQueryInfo,
} from 'mongoose-query-find';
```

```ts
interface QueryParams {
  page?: string;
  limit?: string;
  sort?: string;
  fields?: string;
  q?: string;
  [key: string]: unknown;
}

interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
  limit: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface QueryFindOptions {
  maxTimeMS?: number; // default: 5000
  slowQueryThresholdMS?: number; // default: maxTimeMS
  maxLimit?: number; // default: 100
  lean?: boolean; // default: true
  onSlowQuery?: (info: SlowQueryInfo) => void;
  onSanitizeDrop?: (path: string, value: unknown) => void;
}

interface SlowQueryInfo {
  elapsedMs: number;
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
  page: number;
  limit: number;
}
```

---

## Security

| Protection                  | Detail                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| **NoSQL injection**         | Allowlist enforced on filters, sort, and projection via `.allowFields()`                 |
| **Banned operators**        | `$where`, `$expr`, `$function`, and others are rejected recursively at any nesting depth |
| **ReDoS**                   | Search terms are regex-escaped before compilation                                        |
| **Oversized search**        | `?q=` capped at 200 characters                                                           |
| **Deep nesting DoS**        | Filter object nesting capped at depth 5                                                  |
| **Page size DoS**           | `limit` hard-capped at 100                                                               |
| **Sort abuse**              | Sort fields hard-capped at 5                                                             |
| **Runaway queries**         | `maxTimeMS` applied to both count and find (default: 5s)                                 |
| **Sensitive field leakage** | `?fields=` projection stripped against allowlist                                         |

---

## Links

- [npm](https://www.npmjs.com/package/mongoose-query-find)
- [GitHub](https://github.com/jsdev-robin/mongoose-query-find)
- [Issues](https://github.com/jsdev-robin/mongoose-query-find/issues)

---

## License

ISC © [jsdev.robin@gmail.com](mailto:jsdev.robin@gmail.com)

<br>
<br>

---

---

# QueryAggregate

A fluent, allowlisted **aggregation-pipeline** builder for Mongoose (`^8 || ^9`), built on `Model.aggregate()`. It mirrors the same safety model as `QueryFind` — allowlisted filter fields, sanitized/rejected operators, capped pagination — but adds `$lookup` joins, `$group`, timezone-aware date filtering, custom date/hour ranges, keyset pagination, and one-round-trip dashboard stats.

## QueryAggregate Overview

`QueryFind` is built on `Model.find()` and can't express joins or grouping. `QueryAggregate` solves that while keeping the same guardrails, plus a lot more:

- Allowlisted filter/sort/projection fields
- Recursive sanitization of client input (drops class instances, functions, over-deep nesting)
- Banned-operator rejection (`$where`, `$expr`, `$function`, `$accumulator`, `$map`, `$reduce`, `$filter`)
- Capped pagination (`limit`, `page`)
- Timezone-aware date coercion, `$lookup` joins, arbitrary developer-authored pipeline stages via `.addStage()`
- Single-round-trip pagination via `$facet`
- **New:** six custom date-range methods (arbitrary day, arbitrary span, rolling N-days/N-hours, hour-of-day windows, absolute datetime windows)
- **New:** `count()`, `distinct()`, and `stats()` for cheap metrics without fetching a data page
- **New:** `stream()` for memory-safe large exports, and `paginateCursor()` for keyset pagination on huge collections
- **New:** `explain()`, `debugPipeline()`, and `clone()` for debugging and query reuse

## When to use QueryAggregate vs QueryFind

| Need                                                           | Use              |
| -------------------------------------------------------------- | ---------------- |
| Simple filter/sort/paginate on one collection                  | `QueryFind`      |
| Joining another collection (`$lookup`)                         | `QueryAggregate` |
| Grouping / rollups / computed fields (`$group`, `$addFields`)  | `QueryAggregate` |
| Client filters need to respect the caller's local timezone     | `QueryAggregate` |
| A custom day / date span / rolling window / hour-of-day filter | `QueryAggregate` |
| Dashboard totals (sum/avg/count) without fetching a page       | `QueryAggregate` |
| Very large collections where `$skip` pagination gets slow      | `QueryAggregate` |
| Streaming a large export without buffering it in memory        | `QueryAggregate` |
| You need a custom developer-defined pipeline stage             | `QueryAggregate` |

## Installation

Ships from the same package as `QueryFind`:

```bash
npm install mongoose-query-find
```

## Quick Start

```ts
import { QueryAggregate } from 'mongoose-query-find';
import CategoryModel from './models/category';

const timezone = (req.headers['x-timezone'] as string) ?? 'Asia/Dhaka';

const result = await new QueryAggregate(CategoryModel, req.query, { timezone })
  .allowFields(['name', 'status', 'createdAt'])
  .dateFields(['createdAt'])
  .where({ branchId: req.self.linkedTo, status: { $ne: 'ARCHIVED' } })
  .filter()
  .globalSearch(['name'])
  .sort()
  .project('name status createdAt updatedAt')
  .paginate();
```

`result` shape is identical to `QueryFind`'s `PaginatedResult<T>`:

```json
{
  "data": [...],
  "total": 84,
  "page": 2,
  "totalPages": 9,
  "limit": 10,
  "hasNextPage": true,
  "hasPrevPage": true
}
```

## Constructor & Options

```ts
new QueryAggregate<T>(model, queryString, options?);
```

| Parameter     | Type                    | Description                                     |
| ------------- | ----------------------- | ----------------------------------------------- |
| `model`       | `Model<T>`              | A Mongoose model                                |
| `queryString` | `QueryParams`           | Parsed URL query object, e.g. `req.query`       |
| `options`     | `QueryAggregateOptions` | Configuration options (see below), all optional |

### `QueryAggregateOptions`

| Option                 | Type                                     | Default        | Description                                                                                                                                                   |
| ---------------------- | ---------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timezone`             | `string`                                 | `'Asia/Dhaka'` | IANA timezone for interpreting client-supplied local dates. Invalid values fall back to the default (validated once at construction, never throws mid-query). |
| `maxTimeMS`            | `number`                                 | `5000`         | Max time MongoDB may spend per query. `0` disables.                                                                                                           |
| `slowQueryThresholdMS` | `number`                                 | `maxTimeMS`    | Threshold above which `onSlowQuery` fires.                                                                                                                    |
| `maxLimit`             | `number`                                 | `100`          | Hard cap on `?limit=`.                                                                                                                                        |
| `allowDiskUse`         | `boolean`                                | `false`        | Forwarded to `.allowDiskUse()` — enable for large sort/group pipelines.                                                                                       |
| `weekStartsOn`         | `0–6`                                    | `6` (Saturday) | Used by `.range('thisWeek')`.                                                                                                                                 |
| `onSlowQuery`          | `(info: SlowQueryInfo) => void`          | —              | Callback fired when a query exceeds `slowQueryThresholdMS`.                                                                                                   |
| `onSanitizeDrop`       | `(path: string, value: unknown) => void` | —              | Callback fired whenever sanitization drops a value (bad nesting, non-plain value).                                                                            |

## Timezone Handling

MongoDB always stores/compares dates in UTC. Clients think and filter in local time — `?createdAt=2026-09-01` means "Sept 1st in the caller's timezone," not UTC midnight.

- `fromZonedTime(localString, tz)` → exact UTC instant for a wall-clock time in `tz`. Used to turn a client-supplied local date into the correct `$gte`/`$lt` UTC range in `$match`.
- `toZonedTime(utcDate, tz)` → wall-clock `Date` for `tz`. Used to compute "what day is it right now, in the caller's timezone" for `.range()` presets and the rolling-N-days custom range.

The timezone is a **per-request** value, typically sourced from a header:

```ts
const timezone = (req.headers['x-timezone'] as string) ?? 'Asia/Dhaka';
```

An invalid/unknown IANA timezone string (bad header, typo) never throws — it's validated once at construction (`resolveTimezone`) and silently falls back to the default.

Plain `YYYY-MM-DD` filter values are expanded into a `$gte`/`$lt` range spanning that local day; values with an explicit offset (`Z`, `+06:00`) are treated as absolute instants and passed through as-is. Every custom range method below applies the same timezone-aware logic.

## Builder Methods

All builder methods return `this` and are fully chainable. Recommended call order:

```
allowFields → dateFields/objectIdFields → where → range/rangeXxx → filter → globalSearch → sort → project → lookup/addStage/computeField → paginate/paginateCursor/count/distinct/stats/stream
```

---

### `.allowFields(fields: string[])`

Same role as in `QueryFind`: declares which fields the client may filter, sort, and project. Case-insensitive. Call before `.filter()`, `.sort()`, `.project()`.

```ts
.allowFields(['name', 'status', 'createdAt'])
```

---

### `.dateFields(fields: string[])`

Explicit list of fields treated as dates for timezone-aware coercion. When omitted, falls back to a name heuristic matching `createdAt`, `updatedAt`, `deletedAt`, `archivedAt`, `expiresAt`, `date`, `birthDate` (only when that word is the _last_ path segment, e.g. `user.updatedAt` matches, `updatedAtSomething` doesn't).

```ts
.dateFields(['createdAt', 'updatedAt'])
```

---

### `.objectIdFields(fields: string[])`

Explicit list of fields treated as ObjectId references, so a client-supplied 24-char hex string (`?categoryId=...`) is coerced to `Types.ObjectId` instead of being compared as a plain string (which would never match, since it's a different BSON type). When omitted, falls back to a name heuristic matching `_id` or any field ending in `Id` (e.g. `categoryId`, `basicInfo.brandId`).

```ts
.objectIdFields(['branchId', 'categoryId'])
```

---

### `.filter()`

Parses `req.query` into the aggregation `$match` stage's client-derived portion. Runs, in order:

1. Strips reserved keys (`page`, `sort`, `limit`, `fields`, `q`)
2. `sanitize()` — recursively drops non-plain values (class instances, functions), capped at nesting depth 5
3. `coerceAll()` — timezone-aware date coercion + ObjectId coercion + boolean coercion + numeric coercion + operator-name coercion (`gt` → `$gt`, etc.)
4. `enforceAllowlist()` — strips any non-operator key not in `.allowFields()`
5. `rejectDisallowedOperators()` — throws `QueryAggregateValidationError` on `$where`, `$expr`, `$function`, `$accumulator`, `$map`, `$reduce`, `$filter`, or any unexpected top-level `$` operator

```
GET /categories?createdAt=2026-09-01&status=ACTIVE
```

```ts
.filter()
// → { createdAt: { $gte: <UTC midnight in tz>, $lt: <next UTC midnight in tz> }, status: 'ACTIVE' }
```

---

### `.where(conditions)`

Mandatory server-side conditions the client **cannot override** — kept in a separate internal bucket (`_serverConditions`) and merged last via `$and`, so URL params can never win against it.

```ts
.where({ branchId: req.self.linkedTo, status: { $ne: 'ARCHIVED' } })
```

---

### `.range(field: string, preset: RangePreset)`

Adds a hard, server-defined UTC date range on `field`, computed in this instance's timezone. Not client-overridable (goes into `_serverConditions`, same as `.where()`).

**Presets:** `'today'`, `'yesterday'`, `'last7Days'`, `'last30Days'`, `'thisWeek'`, `'thisMonth'`

```ts
.range('createdAt', 'last7Days')
```

`.range('thisWeek')` respects the `weekStartsOn` constructor option (defaults to Saturday).

---

## Custom Range Methods

Beyond the fixed `RangePreset` values above, six additional methods cover any custom day, span, rolling window, or hour-based filter — without touching `.range()`'s own logic. All of them behave exactly like `.range()`: they write a hard, non-client-overridable condition into `_serverConditions`, in this instance's timezone, and throw `QueryAggregateValidationError` on bad input.

> ⚠️ Only call **one** range method per field. If you call two on the same field (e.g. `.range()` then `.rangeCustom()` on `createdAt`), the later call simply overwrites the earlier one.

### `.rangeCustomDay(field: string, date: string)`

A single arbitrary local calendar date (`YYYY-MM-DD`) — for "show me everything from this specific day" rather than a relative preset.

```ts
.rangeCustomDay('createdAt', '2026-03-14')
```

### `.rangeBetween(field: string, custom: CustomDateRangeInput)`

An arbitrary inclusive local-date span — the classic "from / to" date-picker filter.

```ts
.rangeBetween('createdAt', { from: '2026-01-01', to: '2026-01-31' })
```

### `.rangeLastNDays(field: string, days: number)`

A rolling window of the last N whole calendar days, inclusive of today — a parametrized version of the built-in `last7Days`/`last30Days` presets.

```ts
.rangeLastNDays('createdAt', 14) // last 14 calendar days
```

### `.rangeLastNHours(field: string, hours: number)`

A rolling window of the last N hours, ending at the exact moment the query runs. Unlike the day-based methods, this uses raw UTC instants with no calendar-day snapping — ideal for "recent activity" widgets.

```ts
.rangeLastNHours('createdAt', 6) // activity in the last 6 hours
```

### `.rangeHours(field: string, custom: CustomHourRangeInput)`

An explicit hour-of-day window on a specific local date — e.g. filtering orders placed during business hours.

```ts
.rangeHours('createdAt', { date: '2026-03-14', fromHour: 9, toHour: 17 })
// toHour is exclusive; pass 24 for "through end of day"
```

### `.rangeCustom(field: string, custom: CustomDateTimeRangeInput)`

The most flexible option — an explicit absolute datetime window. Each of `from`/`to` accepts:

- `"YYYY-MM-DD"` → local midnight in this instance's timezone
- `"YYYY-MM-DDTHH:mm:ss[.sss]"` → local wall-clock time in this instance's timezone
- an offset-bearing ISO string (`...Z`, `...+06:00`) → treated as an absolute instant

```ts
.rangeCustom('createdAt', {
  from: '2026-03-14T09:30:00', // local wall-clock
  to: '2026-03-14T18:45:00',
})

// or mixed with an explicit UTC instant:
.rangeCustom('createdAt', { from: '2026-03-14T00:00:00Z', to: '2026-03-15T00:00:00Z' })
```

---

### `.excludeSoftDeleted(field = 'deletedAt')`

Convenience server-side condition excluding soft-deleted documents. Matches both `null` and a genuinely missing field, per MongoDB's equality semantics. Not client-overridable.

```ts
.excludeSoftDeleted() // defaults to 'deletedAt'
.excludeSoftDeleted('removedAt') // or a custom field name
```

---

### `.whereIf(condition, conditions)`

Applies `.where(conditions)` only when `condition` is truthy — avoids scattering `if` statements around a chained builder call.

```ts
.whereIf(req.query.vip === 'true', { tier: 'vip' })
.whereIf(req.self.role !== 'admin', { branchId: req.self.linkedTo })
```

---

### `.globalSearch(fields: string[])`

Identical behavior to `QueryFind`: case-insensitive `$or` regex search across the given fields when `?q=` is present (max 200 chars). Regex-escaped to prevent ReDoS. Fields are filtered against the allowlist first.

```ts
.globalSearch(['name'])
```

---

### `.sort()`

Parses `?sort=` (e.g. `-createdAt,name`), capped at 5 fields, dropping any field not in the allowlist. Falls back to `{ createdAt: -1 }` when absent.

```ts
.sort()
```

> `.paginateCursor()` (below) seeks on this same sort configuration, so call `.sort()` before it if you need a field other than the default `createdAt`.

---

### `.project(defaultProjection?: string | Record<string, 0 | 1>)`

Controls the `$project` stage. Accepts a space-separated string (`"name status -_id"`) or a raw `{ field: 0 | 1 }` object.

- `?fields=` (when present) is parsed and filtered through the allowlist.
- If **every** requested field is blocked, falls back to `defaultProjection` rather than silently returning everything.
- `_id` and `__v` are always allowed through even if not in `allowFields()`.

```ts
.project('name status createdAt updatedAt')
```

> ⚠️ If a preceding `.addStage()` (e.g. `$group`) reshapes documents, `.project()`'s allowlist still only knows about the fields passed to `.allowFields()` — new computed fields may be silently dropped. Use `.addStage({ $project: {...} })` instead when you need full control post-reshape.

---

### `.lookup(opts: LookupOptions)`

Adds a `$lookup` (join) stage, optionally followed by `$unwind`.

| Field          | Type               | Description                                                                                                                        |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `from`         | `string`           | Collection name (not the model name) to join against.                                                                              |
| `as`           | `string`           | Output array field name.                                                                                                           |
| `localField`   | `string?`          | Local join field.                                                                                                                  |
| `foreignField` | `string?`          | Foreign join field.                                                                                                                |
| `pipeline`     | `PipelineStage[]?` | Sub-pipeline form of `$lookup`, for complex/correlated joins. Cannot contain `$out`/`$merge`.                                      |
| `single`       | `boolean?`         | When `true`, `$unwind`s the joined array (`preserveNullAndEmptyArrays: true`) so `as` becomes a single object instead of an array. |

```ts
.lookup({
  from: 'branches',
  as: 'branch',
  localField: 'branchId',
  foreignField: '_id',
  single: true,
})
```

---

### `.computeField(name: string, expression: unknown)`

Convenience wrapper over `.addStage()` for a single computed `$addFields` entry.

```ts
.computeField('margin', { $subtract: ['$price', '$cost'] })
// equivalent to: .addStage({ $addFields: { margin: { $subtract: ['$price', '$cost'] } } })
```

---

### `.addStage(stage: PipelineStage)`

Escape hatch for any other developer-authored stage: `$addFields`, `$group`, a post-join `$match`, a custom `$sort`, etc.

- Blocks **only** `$out` / `$merge` (destructive stages).
- **Does not** run the client-input sanitizer/allowlist/operator-rejection — that only applies to `.filter()`/`.where()`, which parse untrusted `req.query`/`req.body` values.
- **Never pass raw client input directly into `.addStage()`.** It's for stages _you_ author server-side. If you need a client-supplied value inside a custom stage, validate/whitelist it yourself first.

```ts
.addStage({
  $group: {
    _id: '$status',
    count: { $sum: 1 },
    totalAmount: { $sum: '$amount' },
  },
})
```

## Terminal & Utility Methods

### `.paginate(cachedTotal?: number)`

Executes the pipeline and returns `Promise<PaginatedResult<T>>`.

- Uses `$facet` to fetch the data page and total count in a **single round trip**.
- Pass a prior page-1 `total` as `cachedTotal` on later pages to **skip the count stage entirely**.
- `maxTimeMS` / `allowDiskUse` from constructor options are applied to the aggregation.
- If the requested `page` exceeds `totalPages`, page `1` is returned automatically (with the real `total`/`totalPages` still reported).
- `onSlowQuery` (if configured) fires with `{ elapsedMs, pipeline, sort, page, limit }` when the query exceeds `slowQueryThresholdMS`.

> **Note:** `$facet` buffers both branches in memory per query. For very large collections with expensive pre-facet stages (heavy `$lookup`/`$group` before pagination), pass `cachedTotal` on subsequent pages, use `.paginateCursor()` instead, or run `.count()`/data as two separate calls.

```ts
const page1 = await builder.paginate();
const page2 = await builder.paginate(page1.total); // skips re-counting
```

---

### `.paginateCursor(opts?: CursorPaginateOptions)`

Keyset ("seek") pagination — scales far better than `.paginate()`'s `$skip` on deep pages of large collections, at the cost of not supporting "jump to page N". Seeks on whatever field `.sort()` resolved to (falls back to `createdAt` if `.sort()` wasn't called), using `_id` as a stable tiebreaker.

```ts
interface CursorPaginateOptions {
  cursor?: string; // opaque cursor from a previous page's nextCursor
  limit?: number; // overrides ?limit=, still capped by maxLimit
}

interface CursorPaginatedResult<T> {
  data: T[];
  limit: number;
  nextCursor: string | null; // pass this back in as `cursor` for the next page
  hasNextPage: boolean;
}
```

```ts
const p1 = await builder.sort().paginateCursor({ limit: 20 });
const p2 = await builder.paginateCursor({ cursor: p1.nextCursor!, limit: 20 });
// hasNextPage: false / nextCursor: null means you've reached the end
```

Great fit for infinite-scroll feeds and large-export pagination; not a drop-in replacement where the UI needs page numbers.

---

### `.count()`

Returns just the matching document count — cheaper than `.paginate()` when you don't need the data page. Ignores `.project()`/`.sort()`.

```ts
const total = await builder.count();
```

---

### `.distinct(field: string)`

Returns the distinct values of `field` under the current `.filter()`/`.where()`/range conditions.

```ts
const statuses = await builder.distinct('status');
// e.g. ['PENDING', 'PAID', 'CANCELLED']
```

---

### `.stats(specs: StatSpec[])`

Computes one or more aggregate metrics — `sum`, `avg`, `min`, `max`, `count` — in a **single round trip**. Ideal for dashboard totals. Ignores `.project()`/`.sort()`/pagination.

```ts
interface StatSpec {
  name: string;
  op: 'sum' | 'avg' | 'min' | 'max' | 'count';
  field?: string; // required for every op except 'count'
}
```

```ts
const totals = await builder.stats([
  { name: 'revenue', op: 'sum', field: 'total' },
  { name: 'avgOrder', op: 'avg', field: 'total' },
  { name: 'orders', op: 'count' },
]);
// { revenue: 48213, avgOrder: 62.1, orders: 776 }
```

---

### `.stream()`

Returns a Mongoose `AggregationCursor` — async-iterable, no buffering of the full result set in memory. Use for large exports (CSV generation, bulk processing).

```ts
for await (const doc of builder.stream()) {
  csvWriter.write(doc);
}
```

Ignores `page`/`limit`; add your own `$limit` via `.addStage()` if you want a hard cap.

---

### `.explain(verbosity?)`

Runs the built pipeline through Mongoose's `.explain()` — for debugging slow queries and verifying index usage. `verbosity` is `'queryPlanner'` (default), `'executionStats'`, or `'allPlansExecution'`.

```ts
const plan = await builder.explain('executionStats');
```

> Development/ops tool only — never call this in a production request path.

---

### `.clone()`

Deep-copies the current builder state (filters, sort, projection, stages) into a new, independent `QueryAggregate` instance. Handy for branching one shared base query into e.g. both `.paginate()` and `.stats()` without rebuilding the filters twice.

```ts
const base = builder.filter().sort().project('name total createdAt');

const [page, totals] = await Promise.all([
  base.clone().paginate(),
  base.clone().stats([{ name: 'revenue', op: 'sum', field: 'total' }]),
]);
```

---

### `.debugPipeline()`

Returns the fully-built pipeline (`PipelineStage[]`) without executing it — for logging, snapshot tests, or sanity-checking what will actually run.

```ts
console.log(builder.debugPipeline());
```

## Recipes

**Join + post-join filter + group + paginate:**

```ts
const result = await new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['status', 'createdAt'])
  .dateFields(['createdAt'])
  .filter()
  .lookup({
    from: 'customers',
    as: 'customer',
    localField: 'customerId',
    foreignField: '_id',
    single: true,
  })
  .addStage({ $match: { 'customer.vip': true } }) // server-defined, not client-controlled
  .addStage({
    $group: {
      _id: '$customer._id',
      customerName: { $first: '$customer.name' },
      orderCount: { $sum: 1 },
    },
  })
  .sort()
  .paginate();
```

**Relative date range preset (server-enforced, not client-overridable):**

```ts
const result = await new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['status'])
  .where({ branchId: req.self.linkedTo })
  .range('createdAt', 'last30Days')
  .filter()
  .sort()
  .paginate();
```

**Custom hour-of-day window (business hours report):**

```ts
const result = await new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['status'])
  .where({ branchId: req.self.linkedTo })
  .rangeHours('createdAt', {
    date: req.query.day as string,
    fromHour: 9,
    toHour: 21,
  })
  .filter()
  .sort()
  .paginate();
```

**Dashboard: page + totals in parallel, off one shared base:**

```ts
const base = new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['status', 'branchId', 'createdAt', 'total'])
  .dateFields(['createdAt'])
  .where({ branchId: req.self.linkedTo })
  .excludeSoftDeleted()
  .filter()
  .sort()
  .project('status createdAt total');

const [page, totals] = await Promise.all([
  base.clone().paginate(),
  base.clone().stats([
    { name: 'revenue', op: 'sum', field: 'total' },
    { name: 'orders', op: 'count' },
  ]),
]);
```

**Infinite scroll with keyset pagination:**

```ts
const builder = new QueryAggregate(PostModel, req.query, { timezone })
  .allowFields(['authorId', 'createdAt'])
  .where({ published: true })
  .filter()
  .sort();

const page = await builder.paginateCursor({
  cursor: req.query.cursor as string | undefined,
  limit: 20,
});
```

**Streaming a large CSV export:**

```ts
const builder = new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['status', 'createdAt'])
  .where({ branchId: req.self.linkedTo })
  .range('createdAt', 'thisMonth')
  .filter()
  .project('status createdAt total');

res.setHeader('Content-Type', 'text/csv');
for await (const row of builder.stream()) {
  res.write(`${row.status},${row.createdAt.toISOString()},${row.total}\n`);
}
res.end();
```

**ObjectId filter fields (ref lookups by hex ID from the URL):**

```
GET /orders?branchId=64f1a2b3c4d5e6f7a8b9c0d1&categoryId=64f1a2b3c4d5e6f7a8b9c0d2
```

```ts
const result = await new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['branchId', 'categoryId', 'status'])
  .objectIdFields(['branchId', 'categoryId']) // coerces hex strings -> Types.ObjectId
  .filter()
  .sort()
  .paginate();
```

**Role-based server conditions with `.whereIf()` + `.excludeSoftDeleted()`:**

```ts
const result = await new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['status', 'branchId', 'createdAt'])
  .excludeSoftDeleted() // deletedAt: null, always applied
  .whereIf(req.self.role !== 'admin', { branchId: req.self.linkedTo }) // branch staff see only their branch
  .whereIf(req.query.vip === 'true', { tier: 'vip' })
  .filter()
  .sort()
  .paginate();
```

**Populating a filter UI — distinct values + count, no data fetch:**

```ts
const builder = new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['status', 'branchId'])
  .where({ branchId: req.self.linkedTo })
  .filter();

const [statuses, total] = await Promise.all([
  builder.clone().distinct('status'), // populate a <select> of possible statuses
  builder.clone().count(), // "X results" label
]);
```

**Debug route — inspect the built pipeline / query plan without exposing it to normal users:**

```ts
router.get('/orders/_debug', requireAdmin, async (req, res) => {
  const builder = new QueryAggregate(OrderModel, req.query, { timezone })
    .allowFields(['status', 'createdAt'])
    .where({ branchId: req.self.linkedTo })
    .range('createdAt', 'last7Days')
    .filter()
    .sort();

  res.json({
    pipeline: builder.debugPipeline(),
    explain: await builder.explain('executionStats'),
  });
});
```

**Cursor pagination on a non-default sort field:**

```ts
const result = await new QueryAggregate(ProductModel, req.query, { timezone })
  .allowFields(['price', 'name'])
  .where({ inStock: true })
  .filter()
  .sort() // resolves ?sort=price into { price: 1 } — paginateCursor() will seek on "price"
  .paginateCursor({
    cursor: req.query.cursor as string | undefined,
    limit: 24,
  });
```

**Correlated sub-pipeline `$lookup` (needs `let`):**

The built-in `LookupOptions` type doesn't expose `let` for correlated sub-pipelines. For that case, drop to `.addStage()` directly:

```ts
.addStage({
  $lookup: {
    from: 'orderItems',
    let: { orderId: '$_id' },
    pipeline: [
      { $match: { $expr: { $eq: ['$orderId', '$$orderId'] } } },
      { $project: { name: 1, qty: 1 } },
    ],
    as: 'items',
  },
})
```

**Sales analytics dashboard — join, group, and rolling window in one pipeline:**

```ts
const timezone = (req.headers['x-timezone'] as string) ?? 'Asia/Dhaka';

const result = await new QueryAggregate(OrderModel, req.query, { timezone })
  .allowFields(['branchId', 'status'])
  .where({ status: 'PAID' })
  .rangeLastNDays('createdAt', 30) // rolling 30-day window, client can't override
  .filter()
  .lookup({
    from: 'branches',
    as: 'branch',
    localField: 'branchId',
    foreignField: '_id',
    single: true,
  })
  .addStage({
    $group: {
      _id: '$branchId',
      branchName: { $first: '$branch.name' },
      revenue: { $sum: '$total' },
      orders: { $sum: 1 },
      avgOrderValue: { $avg: '$total' },
    },
  })
  .addStage({ $sort: { revenue: -1 } })
  .paginate();
```

**Notification feed — lookup + unwind a single related document per row:**

```ts
const result = await new QueryAggregate(NotificationModel, req.query, {
  timezone,
})
  .allowFields(['read', 'type', 'createdAt'])
  .dateFields(['createdAt'])
  .where({ userId: req.user.id })
  .filter()
  .lookup({
    from: 'users',
    as: 'actor',
    localField: 'actorId',
    foreignField: '_id',
    single: true, // unwinds so `actor` is a single object, not an array
  })
  .sort()
  .project('type read createdAt actor.name actor.avatar')
  .paginate();
```

**Audit log search — global search + a bounded absolute datetime window:**

```ts
const result = await new QueryAggregate(AuditLogModel, req.query, { timezone })
  .allowFields(['action', 'actorId', 'createdAt'])
  .dateFields(['createdAt'])
  .where({ orgId: req.user.orgId })
  .rangeCustom('createdAt', {
    from: (req.query.from as string) ?? '2026-01-01T00:00:00',
    to: (req.query.to as string) ?? new Date().toISOString(),
  })
  .filter()
  .globalSearch(['action'])
  .sort()
  .project('action actorId createdAt')
  .paginate();
```

**Multi-branch inventory report — objectIdFields + computeField + stats side by side:**

```ts
const base = new QueryAggregate(ProductModel, req.query, { timezone })
  .allowFields(['branchId', 'category', 'stock', 'price'])
  .objectIdFields(['branchId'])
  .where({ deletedAt: null })
  .filter()
  .computeField('stockValue', { $multiply: ['$stock', '$price'] })
  .sort()
  .project('branchId category stock price stockValue');

const [page, totals] = await Promise.all([
  base.clone().paginate(),
  base.clone().stats([
    { name: 'totalStockValue', op: 'sum', field: 'stockValue' },
    { name: 'lowStockAvg', op: 'avg', field: 'stock' },
    { name: 'skuCount', op: 'count' },
  ]),
]);

res.json({ ...page, totals });
```

## Pipeline Stage Ordering

The final pipeline is always assembled in this fixed order:

```
$match          (from .where() + .filter() + .range()/rangeXxx() + .globalSearch(), merged via $and)
  ↓
[.lookup() / .addStage() / .computeField() calls, in the order you called them]
  ↓
$project        (from .project(), if set)
  ↓
$sort           (from .sort())
  ↓
[terminal stage: $skip/$limit, $facet, keyset $match + $limit, or $count/$group — added internally by the method you call]
```

Implications:

- Anything added via `.addStage()`/`.computeField()` runs **after** the base filter match and **before** projection/sort.
- If you `$group`/reshape documents, do it before `.project()` — or skip `.project()` and use `.addStage({ $project: {...} })` for full control over the new shape.
- If you add your own `$sort` via `.addStage()` _and_ also call `.sort()`, both stages are included (the builder's `.sort()` stage is always appended last in the base pipeline) — harmless but redundant. Prefer one or the other.
- `.count()`, `.distinct()`, and `.stats()` intentionally skip `$project`/`$sort` — they only need `$match` + your `.lookup()`/`.addStage()` stages before their own terminal `$count`/`$group`.
- `.paginateCursor()` builds its own `$match`/`$sort`/`$limit` tail (the keyset condition), separate from `.paginate()`'s `$facet` tail.

## Security

| Protection                        | Detail                                                                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NoSQL injection**               | Allowlist enforced on `.filter()`/`.sort()`/`.project()` via `.allowFields()`                                                                                                                                                                  |
| **Banned operators**              | `$where`, `$expr`, `$function`, `$accumulator`, `$map`, `$reduce`, `$filter` rejected recursively, any depth, in client input                                                                                                                  |
| **Destructive stages**            | `$out` / `$merge` rejected in `.addStage()` / `.lookup()` sub-pipelines                                                                                                                                                                        |
| **ReDoS**                         | `.globalSearch()` terms are regex-escaped before compilation                                                                                                                                                                                   |
| **Oversized search**              | `?q=` capped at 200 characters                                                                                                                                                                                                                 |
| **Deep nesting DoS**              | Client filter object nesting capped at depth 5 (`sanitize()`)                                                                                                                                                                                  |
| **Page size DoS**                 | `limit` hard-capped at `maxLimit` (default 100), including in `.paginateCursor()`                                                                                                                                                              |
| **Sort abuse**                    | Sort fields hard-capped at 5                                                                                                                                                                                                                   |
| **Runaway queries**               | `maxTimeMS` applied to the aggregation; `onSlowQuery` for observability                                                                                                                                                                        |
| **Bad timezone input**            | Invalid IANA zone validated once at construction, falls back to default, never throws mid-query                                                                                                                                                |
| **Bad custom-range input**        | `rangeCustomDay`/`rangeBetween`/`rangeLastNDays`/`rangeLastNHours`/`rangeHours`/`rangeCustom` all throw `QueryAggregateValidationError` on malformed dates, non-positive counts, or invalid hour bounds — never silently produce a wrong range |
| **Server condition override**     | `.where()` / `.range()` / every custom range method are merged last via `$and` — URL params can never override them                                                                                                                            |
| **Tampered cursors**              | `.paginateCursor()` cursors are opaque base64url-encoded JSON; a malformed cursor throws `QueryAggregateValidationError` rather than silently misbehaving                                                                                      |
| **Untrusted `.addStage()` input** | Not sanitized/allowlisted by design — documented as a trusted, developer-authored-only escape hatch                                                                                                                                            |

> **Important:** `.addStage()` and the `pipeline` option in `.lookup()` are for **server-defined stages only**. They skip the sanitizer/allowlist/operator-rejection that protects `.filter()`/`.where()`. Never interpolate raw `req.query`/`req.body` values into an `.addStage()` call without validating them yourself first.

## TypeScript Types

```ts
import {
  QueryAggregate,
  QueryAggregateOptions,
  QueryAggregateError,
  QueryAggregateValidationError,
  LookupOptions,
  RangePreset,
  SlowQueryInfo,
  QueryParams,
  PaginatedResult,
  CustomDayInput,
  CustomDateRangeInput,
  CustomHourRangeInput,
  CustomDateTimeRangeInput,
  CursorPaginateOptions,
  CursorPaginatedResult,
  StatSpec,
} from 'mongoose-query-find';
```

```ts
interface QueryAggregateOptions {
  timezone?: string;
  maxTimeMS?: number;
  slowQueryThresholdMS?: number;
  maxLimit?: number;
  allowDiskUse?: boolean;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  onSlowQuery?: (info: SlowQueryInfo) => void;
  onSanitizeDrop?: (path: string, value: unknown) => void;
}

interface LookupOptions {
  from: string;
  as: string;
  localField?: string;
  foreignField?: string;
  pipeline?: PipelineStage[];
  single?: boolean;
}

type RangePreset =
  | 'today'
  | 'yesterday'
  | 'last7Days'
  | 'last30Days'
  | 'thisWeek'
  | 'thisMonth';

interface SlowQueryInfo {
  elapsedMs: number;
  pipeline: PipelineStage[];
  sort: Record<string, 1 | -1>;
  page: number;
  limit: number;
}

// ── Custom range types ──────────────────────────────────────────────────────

type CustomDayInput = string; // "YYYY-MM-DD"

interface CustomDateRangeInput {
  from: string; // "YYYY-MM-DD"
  to: string; // "YYYY-MM-DD"
}

interface CustomHourRangeInput {
  date: string; // "YYYY-MM-DD"
  fromHour: number; // 0–24
  toHour: number; // 0–24, exclusive, must be > fromHour
}

interface CustomDateTimeRangeInput {
  from: string; // "YYYY-MM-DD" | "YYYY-MM-DDTHH:mm:ss[.sss]" | offset-bearing ISO string
  to: string;
}

// ── Advanced-feature types ──────────────────────────────────────────────────

interface CursorPaginateOptions {
  cursor?: string;
  limit?: number;
}

interface CursorPaginatedResult<T> {
  data: T[];
  limit: number;
  nextCursor: string | null;
  hasNextPage: boolean;
}

interface StatSpec {
  name: string;
  op: 'sum' | 'avg' | 'min' | 'max' | 'count';
  field?: string;
}
```

---

## Links

- [npm](https://www.npmjs.com/package/mongoose-query-find)
- [GitHub](https://github.com/jsdev-robin/mongoose-query-find)
- [Issues](https://github.com/jsdev-robin/mongoose-query-find/issues)

---

## License

ISC © [jsdev.robin@gmail.com](mailto:jsdev.robin@gmail.com)

<br>
<br>

---

---

# QueryAnalytics

A purpose-built analytics/reporting layer for Mongoose (`^8 || ^9`), sitting alongside `QueryFind` and `QueryAggregate`. Where `QueryAggregate` is a general-purpose, client-input-safe pipeline builder, `QueryAnalytics` is a **server-authored dashboard toolkit**: time series, cohort retention, funnels, sessionization, percentiles, and more, each backed by a native MongoDB 7.0+ operator instead of a hand-rolled pipeline.

## QueryAnalytics Overview

`QueryAnalytics` wraps `Model.aggregate()` with dashboard-shaped methods that return ready-to-chart data instead of raw pipeline rows:

- `timeSeries()` / `cumulativeSeries()` — bucketed metrics over time, gap-filled, with a native running total
- `compare()` — period-over-period totals and % change for preset windows (today, this week, last 30 days, ...)
- `breakdown()` / `rankedBreakdown()` / `multiBreakdown()` — top-N by one or two dimensions, with an optional native dense rank
- `funnel()` — step-by-step conversion counts
- `cohortRetention()` — a full cohort-by-cohort retention matrix
- `sessionize()` — gap-based event sessionization
- `percentiles()` / `stdDevOutliers()` — native `$percentile` / `$stdDevPop` statistics
- `metrics()` — several independent totals in a single round trip
- `heatmap()` — weekday × hour-of-day activity grid
- `movingAverage()` / `trend()` / `forecast()` — pure-JS post-processing on a series you already fetched
- `watch()` — a live change-stream feed for dashboards that update in real time
- `toCSV()` / `toNDJSON()` / `dashboard()` — export and batch helpers

It targets **MongoDB 7.0+** and uses `$setWindowFields`, `$denseRank`, `$shift`, `$stdDevPop`, and `$percentile` directly — there's no fallback path for older servers, so calling `cumulativeSeries()`, `rankedBreakdown()`, `sessionize()`, `percentiles()`, or `stdDevOutliers()` against a pre-7.0 deployment will fail at the server, not in this library.

## When to use QueryAnalytics

| Need                                                             | Use              |
| ---------------------------------------------------------------- | ---------------- |
| Filtered/sorted/paginated list from client query params          | `QueryFind`      |
| Joins, grouping, or a client-driven filtered data page           | `QueryAggregate` |
| A chart-ready time series with gaps filled in                    | `QueryAnalytics` |
| Week-over-week / month-over-month KPI comparisons                | `QueryAnalytics` |
| Top-N breakdowns, ranked leaderboards, or a two-dimension pivot  | `QueryAnalytics` |
| Signup → activation → purchase funnel counts                     | `QueryAnalytics` |
| "% of signups still active N weeks later" retention tables       | `QueryAnalytics` |
| Turning a raw event stream into user sessions                    | `QueryAnalytics` |
| p50/p90/p99 latency or order-value percentiles                   | `QueryAnalytics` |
| Flagging statistical outliers for an anomalies widget            | `QueryAnalytics` |
| A whole dashboard's worth of metrics in one call from your route | `QueryAnalytics` |
| Pushing live updates to a dashboard instead of polling           | `QueryAnalytics` |

`QueryAnalytics` is **not** a client-input parser. Unlike `QueryFind`/`QueryAggregate`, it has no `.filter()`, no `.allowFields()`, and no operator-rejection pass over untrusted input — see [Security](#security-2) below.

## Installation

Ships from the same package as `QueryFind` and `QueryAggregate`:

```bash
npm install mongoose-query-find
```

## Quick Start

```ts
import { QueryAnalytics } from 'mongoose-query-find';
import OrderModel from './models/order';

const qa = new QueryAnalytics(OrderModel, { timezone: 'Asia/Dhaka' })
  .match({ branchId, status: { $ne: 'CANCELLED' } })
  .dateRange('createdAt', { from: '2026-08-01', to: '2026-08-31' });

const series = await qa.timeSeries({
  dateField: 'createdAt',
  interval: 'day',
  metrics: [
    { name: 'revenue', op: 'sum', field: 'total' },
    { name: 'orders', op: 'count' },
  ],
});
```

`series` is a gap-filled array ready to hand straight to a charting library:

```json
[
  { "bucket": "2026-08-01T00:00:00.000Z", "revenue": 4820, "orders": 61 },
  { "bucket": "2026-08-02T00:00:00.000Z", "revenue": 0, "orders": 0 },
  { "bucket": "2026-08-03T00:00:00.000Z", "revenue": 5310, "orders": 74 }
]
```

## Constructor & Options

```ts
new QueryAnalytics<T>(model, options?);
```

| Parameter | Type                    | Description                 |
| --------- | ----------------------- | --------------------------- |
| `model`   | `Model<T>`              | A Mongoose model            |
| `options` | `QueryAnalyticsOptions` | Configuration, all optional |

### `QueryAnalyticsOptions`

| Option         | Type      | Default        | Description                                                                                                                                          |
| -------------- | --------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timezone`     | `string`  | `'Asia/Dhaka'` | IANA timezone for bucketing and range math. Invalid values are validated once at construction and silently fall back to the default.                 |
| `maxTimeMS`    | `number`  | `8000`         | Max time MongoDB may spend per query. Higher than `QueryFind`/`QueryAggregate`'s default since analytics pipelines tend to be heavier. `0` disables. |
| `allowDiskUse` | `boolean` | `false`        | Forwarded to `.allowDiskUse()` for large `$group`/`$setWindowFields` stages.                                                                         |
| `weekStartsOn` | `0–6`     | `6` (Saturday) | Used by weekly bucketing (`interval: 'week'`), `compare({ preset: 'thisWeek' })`, and `cohortRetention()`.                                           |
| `cacheTTLMs`   | `number`  | `0`            | TTL in ms for the built-in in-memory cache. `0` disables caching. **See note below.**                                                                |

> **Note on `cacheTTLMs`:** the class ships a small in-memory TTL cache (`cacheGet`/`cacheSet`) and a `QueryAnalytics.clearCache()` static, but as of this release none of the public methods (`timeSeries`, `breakdown`, `metrics`, etc.) pass a cache key into it — so setting `cacheTTLMs` doesn't yet cache anything on its own. Treat it as reserved for a future release; if you need caching today, memoize at the call site (e.g. wrap `dashboard()` calls in your own short-lived cache).

## Base Filter Methods

### `.match(conditions)`

Merges hard, developer-authored conditions into the base `$match`. Call as many times as needed — later calls merge over earlier ones on the same key via `Object.assign`.

```ts
qa.match({ branchId, status: { $ne: 'CANCELLED' } });
```

Because `QueryAnalytics` has no `.filter()`, `match()` is the _only_ way conditions enter the pipeline besides `.dateRange()` and `.addStage()` — there's no allowlist because there's no untrusted input path. Don't pass raw `req.query` into it directly; validate/whitelist any client-influenced value yourself first (see [Security](#security-2)).

### `.dateRange(field: string, range: { from: string; to: string })`

Hard, inclusive local-date range condition on `field`, converted to a UTC `$gte`/`$lt` window using the instance's timezone.

```ts
qa.dateRange('createdAt', { from: '2026-08-01', to: '2026-08-31' });
```

Throws `QueryAnalyticsError` if `from`/`to` aren't `YYYY-MM-DD`.

### `.addStage(stage: PipelineStage)`

Escape hatch for extra developer-authored stages, spliced in right after the base `$match`, before any analytics-specific stages. Blocks `$out`/`$merge` recursively, at any nesting depth.

```ts
qa.addStage({ $addFields: { margin: { $subtract: ['$price', '$cost'] } } });
```

### `.clone()`

Copies the current filter state (`match()`/`dateRange()` conditions and `addStage()` stages) into a new, independent `QueryAnalytics` instance sharing the same options. Handy for branching one filtered base into several analytics calls without rebuilding the filter each time — see [Recipes](#recipes-1).

## Time Series

### `.timeSeries(opts)`

Buckets documents by `dateField` into timezone-aligned `interval` buckets (`'hour' | 'day' | 'week' | 'month'`) via `$dateTrunc`, computes `metrics` per bucket, and — by default — fills empty buckets with zero values so a chart never shows a broken line for a quiet day.

```ts
interface StatSpec {
  name: string;
  op: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinctCount';
  field?: string; // required for every op except 'count'
}

await qa.timeSeries({
  dateField: 'createdAt',
  interval: 'day',
  metrics: [
    { name: 'revenue', op: 'sum', field: 'total' },
    { name: 'orders', op: 'count' },
    { name: 'customers', op: 'distinctCount', field: 'customerId' },
  ],
  fillGaps: true, // default
});
```

`interval: 'week'` respects the constructor's `weekStartsOn`. Set `fillGaps: false` to get back only buckets that actually had data.

### `.cumulativeSeries(opts)`

Same bucketing as `timeSeries()`, plus a native running-total column per metric (`${name}_cumulative`), computed server-side via `$setWindowFields` — no client-side accumulation pass.

```ts
await qa.cumulativeSeries({
  dateField: 'createdAt',
  interval: 'day',
  metrics: [{ name: 'revenue', op: 'sum', field: 'total' }],
});
// [{ bucket: '...', revenue: 420, revenue_cumulative: 420 }, { bucket: '...', revenue: 310, revenue_cumulative: 730 }, ...]
```

`distinctCount` metrics are skipped for the cumulative column — a running distinct-count isn't a well-defined windowed sum. Unlike `timeSeries()`, this method has no `fillGaps` option.

## Comparisons & Breakdowns

### `.compare(opts)`

Computes `metrics` for a preset current period and the equivalent prior period, plus absolute and percentage change.

```ts
interface CompareResult {
  current: Record<string, number>;
  previous: Record<string, number>;
  change: Record<string, number>; // absolute delta
  changePct: Record<string, number | null>; // null when previous was 0
}

const result = await qa.compare({
  dateField: 'createdAt',
  metrics: [{ name: 'revenue', op: 'sum', field: 'total' }],
  preset: 'last7Days',
});
```

**Presets:** `'today' | 'thisWeek' | 'thisMonth' | 'last7Days' | 'last30Days'`. `'thisWeek'`/`'thisMonth'` compare against a prior period of the same length (e.g. 12 days into this month vs. the last 12 days of last month), and `'thisWeek'` respects `weekStartsOn`.

> Any `.dateRange()` you've already applied on the instance is **ignored** here — the preset defines both windows on its own, independent of the instance's filter state. `.match()` conditions still apply to both windows.

### `.breakdown(field, metrics, opts)`

Groups by `field`, computes `metrics` per group, sorted and capped.

```ts
await qa.breakdown(
  'category',
  [{ name: 'revenue', op: 'sum', field: 'total' }],
  {
    limit: 10, // default 10
    sortBy: 'revenue', // default: metrics[0].name
    sortDir: -1, // default -1
  },
);
// [{ key: 'Electronics', revenue: 18400 }, { key: 'Home', revenue: 9210 }, ...]
```

### `.rankedBreakdown(field, metrics, opts)`

Same as `breakdown()`, but adds a native 1-based dense-rank column via `$setWindowFields`/`$denseRank` — no client-side re-sorting needed for a leaderboard UI.

```ts
await qa.rankedBreakdown('salesRepId', [
  { name: 'revenue', op: 'sum', field: 'total' },
]);
// [{ key: 'rep_1', rank: 1, revenue: 18400 }, { key: 'rep_2', rank: 2, revenue: 18400 }, { key: 'rep_3', rank: 4, revenue: 9210 }, ...]
```

Ties share a rank and the next distinct value skips ahead (standard dense-rank semantics), so two reps tied for first both show `rank: 1` and the next lowest gets `rank: 2`.

### `.multiBreakdown(fields, metrics, opts)`

Pivot table: groups by two dimensions at once, one row per `(dimA, dimB)` pair.

```ts
await qa.multiBreakdown(
  ['branchId', 'status'],
  [{ name: 'orders', op: 'count' }],
  {
    limit: 200, // optional; no cap by default
  },
);
// [{ key: 'branch_a', key2: 'PAID', orders: 40 }, { key: 'branch_a', key2: 'REFUNDED', orders: 3 }, ...]
```

Rows are sorted by `key` then `key2` ascending. There's no default `limit` — pass one for large dimension combinations.

## Funnels & Cohorts

### `.funnel(steps)`

Counts how many base documents match each step's condition, independently, in parallel.

```ts
const result = await qa.funnel([
  { name: 'Visited', match: {} },
  { name: 'Signed up', match: { signedUpAt: { $ne: null } } },
  { name: 'Purchased', match: { firstOrderAt: { $ne: null } } },
]);
```

```ts
interface FunnelResult {
  name: string;
  count: number;
  conversionFromPrevious: number | null; // %
  conversionFromStart: number | null; // %
}
```

Each step's `match` is ANDed with the instance's base filter — steps are **independent counts**, not automatically cumulative. If step 3 should imply step 2, include that condition in step 3's `match` yourself. `conversionFromPrevious`/`conversionFromStart` are `null` for the first step, and `null` (instead of `Infinity`/`NaN`) whenever the denominator is 0.

### `.cohortRetention(opts)`

Buckets entities into cohorts by the first occurrence of `cohortDateField`, then measures how many of each cohort had activity (`activityDateField`) in each subsequent period.

```ts
interface CohortRetentionOptions {
  cohortDateField: string; // e.g. signup date
  activityDateField: string; // e.g. any return-visit date (can equal cohortDateField)
  idField: string; // e.g. userId
  cohortInterval: 'hour' | 'day' | 'week' | 'month';
  periods: number; // how many periods forward to measure
}

const table = await qa.cohortRetention({
  cohortDateField: 'signupAt',
  activityDateField: 'lastActiveAt',
  idField: 'userId',
  cohortInterval: 'week',
  periods: 8,
});
```

```ts
interface CohortRow {
  cohort: string; // ISO bucket start
  cohortSize: number;
  retention: (number | null)[]; // index 0 = period 0
  retentionPct: (number | null)[];
}
```

Two aggregate calls run first (cohort assignment, then distinct activity buckets), and the retention matrix itself is assembled in JS afterward. Notes:

- `retention[0]` (period 0) falls back to the full `cohortSize` when there's no explicit activity row recorded at offset 0 — useful when the cohort event and the first activity event are the same document, but worth checking if your two date fields can genuinely diverge at period 0.
- For `cohortInterval: 'month'`, offsets are computed against an approximate 30-day month for period-bucketing math; the cohort buckets themselves are exact (via `$dateTrunc`), only the offset-from-cohort calculation is approximate.

### `.sessionize(opts)`

Groups per-user events into sessions using native `$setWindowFields` + `$shift` gap detection — no self-lookup or JS grouping pass.

```ts
interface SessionizeOptions {
  userField: string;
  dateField: string;
  gapMinutes: number; // idle gap after which a new session starts
}

const sessions = await qa.sessionize({
  userField: 'userId',
  dateField: 'eventAt',
  gapMinutes: 30,
});
```

```ts
interface SessionSummary {
  userId: unknown;
  sessionStart: string;
  sessionEnd: string;
  eventCount: number;
  durationSeconds: number;
}
```

## Statistics

### `.percentiles(field, ps)`

Percentiles (0–100) of `field` over the current filter, via native `$percentile` (`method: 'approximate'`).

```ts
await qa.percentiles('total', [50, 90, 99]);
// { p50: 42, p90: 118, p99: 340 }
```

Values are `null` when there's no matching data.

### `.stdDevOutliers(field, opts)`

Flags documents whose `field` value is more than `threshold` standard deviations from the mean, using native `$stdDevPop`.

```ts
await qa.stdDevOutliers('total', { threshold: 3, limit: 50 }); // defaults shown
```

```ts
interface OutlierRow {
  _id: unknown;
  value: number;
  zScore: number;
  [key: string]: unknown; // full source document is spread in
}
```

Two round trips: one to compute `mean`/`stdDev` over the full filtered set, one to fetch flagged rows. Returns `[]` if there's no data or the standard deviation is 0 (constant field).

> **Caveat:** rows are sorted by `zScore` descending before `limit` is applied, so with a tight `limit` on a field that has outliers on both tails, strongly _positive_ outliers can crowd out strongly _negative_ ones. Raise `limit` (or drop the `$limit` and sort by `Math.abs(zScore)` yourself) if you need both tails represented fairly.

### `.metrics(specs)`

Several independent `StatSpec` metrics in one round trip — cheaper than N separate calls for a KPI-strip widget.

```ts
await qa.metrics([
  { name: 'revenue', op: 'sum', field: 'total' },
  { name: 'avgOrder', op: 'avg', field: 'total' },
  { name: 'orders', op: 'count' },
]);
// { revenue: 48213, avgOrder: 62.1, orders: 776 }
```

## Post-Processing Helpers (static)

These run entirely in JS against a series you've already fetched — no database call.

### `QueryAnalytics.movingAverage()`

Adds a trailing moving-average field to an existing time series.

```ts
QueryAnalytics.movingAverage(series, 'revenue', 7); // adds `revenue_ma`
```

The window shrinks near the start of the series rather than looking backward past index 0 (so the first point's average is just itself, the second is the average of the first two, and so on). Throws `QueryAnalyticsError` if `windowSize < 1`.

### `QueryAnalytics.trend()`

Simple up/down/flat classification, comparing the average of the last `n` points to the `n` before that.

```ts
QueryAnalytics.trend(series, 'revenue', 3, 2); // n=3, flatThresholdPct=2 (defaults)
// 'up' | 'down' | 'flat' | 'insufficient_data'
```

Returns `'insufficient_data'` when the series has fewer than `2 * n` points.

### `QueryAnalytics.forecast()`

A simple linear-regression projection for `periodsAhead` future buckets, based on the series' existing trend line.

```ts
QueryAnalytics.forecast(series, 'revenue', 7);
// [{ index: 30, predicted: 512.4 }, { index: 31, predicted: 518.9 }, ...]
```

Good enough for a dashed projection line on a chart — not a substitute for a real forecasting model. Returns `[]` for series shorter than 2 points.

## `.heatmap(dateField, valueField?)`

Counts (or sums `valueField`, if given) by weekday (0=Sun..6=Sat, local timezone) × hour-of-day (0–23, local timezone).

```ts
await qa.heatmap('createdAt');
// [{ weekday: 0, hour: 0, value: 4 }, { weekday: 0, hour: 1, value: 1 }, ...]

await qa.heatmap('createdAt', 'total'); // sum revenue instead of counting docs
```

Returns a flat array (one row per `weekday`/`hour` combination that occurred), not a pre-filled 7×24 matrix — fill in the zero cells client-side if your chart needs a dense grid.

## Live Updates

### `.watch(onChange, opts)`

Subscribes to a MongoDB change stream on the model's collection and invokes `onChange` for every matching insert/update/delete/replace — handy for pushing live dashboard updates over a websocket instead of polling.

```ts
const stream = qa.watch(
  (change) => io.emit('order:change', change),
  { operationTypes: ['insert', 'update'] }, // optional; all types by default
);

// later
stream.close();
```

Returns the underlying `ChangeStream` — the caller owns its lifecycle and must `.close()` it. `fullDocument: 'updateLookup'` is set so update events include the full document.

Two things worth knowing:

- Only conditions set via `.match()`/`.dateRange()` are translated onto the stream (as `fullDocument.<field>` equality conditions) — stages added via `.addStage()` aren't part of the change-stream pipeline.
- Change streams require a MongoDB replica set or Atlas cluster; they don't work against a standalone `mongod`.

## Export & Batch Helpers (static)

### `QueryAnalytics.toCSV()` / `toNDJSON()`

Flatten an array of plain-object rows (e.g. the output of `timeSeries()`/`breakdown()`) into CSV or newline-delimited JSON.

```ts
QueryAnalytics.toCSV(rows); // header row inferred from the union of all row keys; values with , " or \n are quoted
QueryAnalytics.toNDJSON(rows); // one JSON.stringify(row) per line — friendlier for streaming large exports
```

### `QueryAnalytics.dashboard()`

Runs several named analytics calls in parallel and returns them keyed by name — one round trip from the caller's perspective (though each named task is still its own aggregate call under the hood).

```ts
const data = await QueryAnalytics.dashboard({
  revenue: () =>
    qa.timeSeries({
      dateField: 'createdAt',
      interval: 'day',
      metrics: [{ name: 'revenue', op: 'sum', field: 'total' }],
    }),
  topCategories: () =>
    qa.breakdown('category', [{ name: 'revenue', op: 'sum', field: 'total' }]),
  totals: () => qa.metrics([{ name: 'orders', op: 'count' }]),
});
// { revenue: [...], topCategories: [...], totals: { orders: 776 } }
```

### `QueryAnalytics.clearCache()`

Clears the shared in-memory cache. **Process-wide** — not scoped to one instance or one model. (See the caching note under [Constructor & Options](#constructor--options-2): as of this release, nothing populates the cache yet via the public API.)

## Recipes

**Branch dashboard in one round trip:**

```ts
const qa = new QueryAnalytics(OrderModel, { timezone })
  .match({ branchId: req.self.linkedTo, status: { $ne: 'CANCELLED' } })
  .dateRange('createdAt', {
    from: req.query.from as string,
    to: req.query.to as string,
  });

const dashboard = await QueryAnalytics.dashboard({
  series: () =>
    qa.timeSeries({
      dateField: 'createdAt',
      interval: 'day',
      metrics: [
        { name: 'revenue', op: 'sum', field: 'total' },
        { name: 'orders', op: 'count' },
      ],
    }),
  topProducts: () =>
    qa.breakdown(
      'productId',
      [{ name: 'revenue', op: 'sum', field: 'total' }],
      { limit: 5 },
    ),
  kpis: () =>
    qa.metrics([
      { name: 'revenue', op: 'sum', field: 'total' },
      { name: 'orders', op: 'count' },
    ]),
});

res.json(dashboard);
```

**Week-over-week KPI strip:**

```ts
const wow = await new QueryAnalytics(OrderModel, { timezone })
  .match({ branchId: req.self.linkedTo })
  .compare({
    dateField: 'createdAt',
    preset: 'thisWeek',
    metrics: [
      { name: 'revenue', op: 'sum', field: 'total' },
      { name: 'orders', op: 'count' },
    ],
  });

res.json(wow); // { current, previous, change, changePct }
```

**Signup retention curve, branched off one base filter:**

```ts
const base = new QueryAnalytics(UserModel, { timezone }).match({
  orgId: req.user.orgId,
});

const [retention, funnel] = await Promise.all([
  base.clone().cohortRetention({
    cohortDateField: 'signupAt',
    activityDateField: 'lastActiveAt',
    idField: '_id',
    cohortInterval: 'week',
    periods: 8,
  }),
  base.clone().funnel([
    { name: 'Signed up', match: {} },
    { name: 'Activated', match: { activatedAt: { $ne: null } } },
    { name: 'Subscribed', match: { subscribedAt: { $ne: null } } },
  ]),
]);
```

**Anomalies widget with a projected trend line:**

```ts
const qa = new QueryAnalytics(OrderModel, { timezone }).match({ branchId });

const series = await qa.timeSeries({
  dateField: 'createdAt',
  interval: 'day',
  metrics: [{ name: 'revenue', op: 'sum', field: 'total' }],
});

const withMA = QueryAnalytics.movingAverage(series, 'revenue', 7);
const trend = QueryAnalytics.trend(series, 'revenue');
const projection = QueryAnalytics.forecast(series, 'revenue', 7);
const outliers = await qa.stdDevOutliers('total', { threshold: 3 });

res.json({ series: withMA, trend, projection, outliers });
```

**Live order feed alongside a polled summary:**

```ts
const qa = new QueryAnalytics(OrderModel, { timezone }).match({ branchId });

const stream = qa.watch(
  (change) => io.to(`branch:${branchId}`).emit('order:change', change),
  {
    operationTypes: ['insert'],
  },
);

req.on('close', () => stream.close());
```

## Security

| Protection                      | Detail                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No client-input path**        | `QueryAnalytics` has no `.filter()`/`.allowFields()` — every condition comes from `.match()`, `.dateRange()`, or `.addStage()`, all developer-authored. Don't pass raw `req.query`/`req.body` into any of them without validating it yourself first.    |
| **Destructive stages**          | `$out`/`$merge` are rejected recursively, at any nesting depth, in `.addStage()`.                                                                                                                                                                       |
| **Strict date parsing**         | `.dateRange()` requires `YYYY-MM-DD` and throws `QueryAnalyticsError` on anything else — no silent misinterpretation of ambiguous date strings.                                                                                                         |
| **Runaway queries**             | `maxTimeMS` (default `8000`) is applied to every aggregation.                                                                                                                                                                                           |
| **Bad timezone input**          | An invalid IANA timezone is validated once at construction and silently falls back to the default, rather than throwing mid-query.                                                                                                                      |
| **MongoDB version requirement** | `cumulativeSeries()`, `rankedBreakdown()`, `sessionize()`, `percentiles()`, and `stdDevOutliers()` require MongoDB 7.0+; there's no feature-detection or fallback, so calling them against an older server surfaces as a server-side aggregation error. |
| **Change-stream requirements**  | `.watch()` requires a replica set or Atlas cluster and only forwards `.match()`/`.dateRange()` conditions onto the stream, not `.addStage()` stages.                                                                                                    |

> **Important:** because there's no allowlist here, field names passed to `breakdown()`, `multiBreakdown()`, `heatmap()`, etc. should come from your own code or a whitelist you maintain — not directly from a query string — the same way you'd treat any other server-authored aggregation field.

## TypeScript Types

```ts
import {
  QueryAnalytics,
  QueryAnalyticsOptions,
  QueryAnalyticsError,
  Interval,
  ComparePreset,
  StatSpec,
  TimeSeriesPoint,
  CompareResult,
  BreakdownRow,
  RankedBreakdownRow,
  FunnelStep,
  FunnelResult,
  CohortRetentionOptions,
  CohortRow,
  SessionizeOptions,
  SessionSummary,
  OutlierRow,
} from 'mongoose-query-find';
```

```ts
type Interval = 'hour' | 'day' | 'week' | 'month';

type ComparePreset =
  | 'today'
  | 'thisWeek'
  | 'thisMonth'
  | 'last7Days'
  | 'last30Days';

interface StatSpec {
  name: string;
  op: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinctCount';
  field?: string; // required for every op except 'count'
}

interface QueryAnalyticsOptions {
  timezone?: string;
  maxTimeMS?: number;
  allowDiskUse?: boolean;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  cacheTTLMs?: number;
}

interface TimeSeriesPoint {
  bucket: string; // ISO string, local-boundary-aligned
  [metric: string]: number | string;
}

interface CompareResult {
  current: Record<string, number>;
  previous: Record<string, number>;
  change: Record<string, number>;
  changePct: Record<string, number | null>;
}

interface BreakdownRow {
  key: unknown;
  [metric: string]: unknown;
}

interface RankedBreakdownRow extends BreakdownRow {
  rank: number;
}

interface FunnelStep {
  name: string;
  match: Record<string, unknown>;
}

interface FunnelResult {
  name: string;
  count: number;
  conversionFromPrevious: number | null;
  conversionFromStart: number | null;
}

interface CohortRetentionOptions {
  cohortDateField: string;
  activityDateField: string;
  idField: string;
  cohortInterval: Interval;
  periods: number;
}

interface CohortRow {
  cohort: string;
  cohortSize: number;
  retention: (number | null)[];
  retentionPct: (number | null)[];
}

interface SessionizeOptions {
  userField: string;
  dateField: string;
  gapMinutes: number;
}

interface SessionSummary {
  userId: unknown;
  sessionStart: string;
  sessionEnd: string;
  eventCount: number;
  durationSeconds: number;
}

interface OutlierRow {
  _id: unknown;
  value: number;
  zScore: number;
  [key: string]: unknown;
}
```

## Links

- [npm](https://www.npmjs.com/package/mongoose-query-find)
- [GitHub](https://github.com/jsdev-robin/mongoose-query-find)
- [Issues](https://github.com/jsdev-robin/mongoose-query-find/issues)

## License

ISC © [jsdev.robin@gmail.com](mailto:jsdev.robin@gmail.com)
