# mongoose-query-find

[![npm version](https://img.shields.io/npm/v/mongoose-query-find)](https://www.npmjs.com/package/mongoose-query-find)
[![license](https://img.shields.io/npm/l/mongoose-query-find)](https://github.com/jsdev-robin/mongoose-query-find/blob/main/LICENSE)
[![mongoose peer](https://img.shields.io/badge/mongoose-%5E8%20%7C%7C%20%5E9-brightgreen)](https://mongoosejs.com)

A fluent, chainable query builder for Mongoose that handles filtering, global search, sorting, field projection, population, and pagination — all driven directly from URL query parameters with zero boilerplate.

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
  - [.filter()](#filter-1)
  - [.where()](#whereconditions-1)
  - [.range()](#rangefield-string-preset-rangepreset)
  - [.globalSearch()](#globalsearchfields-string-1)
  - [.sort()](#sort-1)
  - [.project()](#projectdefaultprojection-string--recordstring-0--1)
  - [.lookup()](#lookupopts-lookupoptions)
  - [.addStage()](#addstagestage-pipelinestage)
- [Terminal Method](#terminal-method-1)
  - [.paginate()](#paginatecachedtotal-number)
- [Recipes](#recipes)
- [Pipeline Stage Ordering](#pipeline-stage-ordering)
- [Security](#security-1)
- [TypeScript Types](#typescript-types-1)

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

| Option      | Type     | Default | Description                                                            |
| ----------- | -------- | ------- | ---------------------------------------------------------------------- |
| `maxTimeMS` | `number` | `5000`  | Max milliseconds MongoDB may spend on each query. Pass `0` to disable. |

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

## TypeScript Types

All types are exported:

```ts
import {
  queryFind,
  QueryFind,
  QueryParams,
  PaginatedResult,
  QueryFindOptions,
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

A fluent, allowlisted **aggregation-pipeline** builder for Mongoose (`^8 || ^9`), built on `Model.aggregate()`. It mirrors the same safety model as `QueryFind` — allowlisted filter fields, sanitized/rejected operators, capped pagination — but adds `$lookup` joins, `$group`, and any other pipeline-only stage, plus timezone-aware date filtering.

## QueryAggregate Overview

`QueryFind` is built on `Model.find()` and can't express joins or grouping. `QueryAggregate` solves that while keeping the same guardrails:

- Allowlisted filter/sort/projection fields
- Recursive sanitization of client input (drops class instances, functions, over-deep nesting)
- Banned-operator rejection (`$where`, `$expr`, `$function`, `$accumulator`, `$map`, `$reduce`, `$filter`)
- Capped pagination (`limit`, `page`)
- **New:** timezone-aware date coercion, `$lookup` joins, arbitrary developer-authored pipeline stages via `.addStage()`, and single-round-trip pagination via `$facet`

## When to use QueryAggregate vs QueryFind

| Need                                                          | Use              |
| ------------------------------------------------------------- | ---------------- |
| Simple filter/sort/paginate on one collection                 | `QueryFind`      |
| Joining another collection (`$lookup`)                        | `QueryAggregate` |
| Grouping / rollups / computed fields (`$group`, `$addFields`) | `QueryAggregate` |
| Client filters need to respect the caller's local timezone    | `QueryAggregate` |
| You need a custom developer-defined pipeline stage            | `QueryAggregate` |

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
- `toZonedTime(utcDate, tz)` → wall-clock `Date` for `tz`. Used to compute "what day is it right now, in the caller's timezone" for `.range()` presets.

The timezone is a **per-request** value, typically sourced from a header:

```ts
const timezone = (req.headers['x-timezone'] as string) ?? 'Asia/Dhaka';
```

An invalid/unknown IANA timezone string (bad header, typo) never throws — it's validated once at construction (`resolveTimezone`) and silently falls back to the default.

Plain `YYYY-MM-DD` filter values are expanded into a `$gte`/`$lt` range spanning that local day; values with an explicit offset (`Z`, `+06:00`) are treated as absolute instants and passed through as-is.

## Builder Methods

All builder methods return `this` and are fully chainable. Recommended call order:

```
allowFields → dateFields → where → range → filter → globalSearch → sort → project → lookup/addStage → paginate
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

### `.filter()`

Parses `req.query` into the aggregation `$match` stage's client-derived portion. Runs, in order:

1. Strips reserved keys (`page`, `sort`, `limit`, `fields`, `q`)
2. `sanitize()` — recursively drops non-plain values (class instances, functions), capped at nesting depth 5
3. `coerceAll()` — timezone-aware date coercion + boolean coercion + operator-name coercion (`gt` → `$gt`, etc.)
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

## Terminal Method

### `.paginate(cachedTotal?: number)`

Executes the pipeline and returns `Promise<PaginatedResult<T>>`.

- Uses `$facet` to fetch the data page and total count in a **single round trip**.
- Pass a prior page-1 `total` as `cachedTotal` on later pages to **skip the count stage entirely**.
- `maxTimeMS` / `allowDiskUse` from constructor options are applied to the aggregation.
- If the requested `page` exceeds `totalPages`, page `1` is returned automatically (with the real `total`/`totalPages` still reported).
- `onSlowQuery` (if configured) fires with `{ elapsedMs, pipeline, sort, page, limit }` when the query exceeds `slowQueryThresholdMS`.

> **Note:** `$facet` buffers both branches in memory per query. For very large collections with expensive pre-facet stages (heavy `$lookup`/`$group` before pagination), pass `cachedTotal` on subsequent pages, or run count/data as two separate calls instead.

```ts
const page1 = await builder.paginate();
const page2 = await builder.paginate(page1.total); // skips re-counting
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

## Pipeline Stage Ordering

The final pipeline is always assembled in this fixed order:

```
$match          (from .where() + .filter() + .range() + .globalSearch(), merged via $and)
  ↓
[.lookup() / .addStage() calls, in the order you called them]
  ↓
$project        (from .project(), if set)
  ↓
$sort           (from .sort())
  ↓
[pagination: $skip/$limit, or $facet — added internally by .paginate()]
```

Implications:

- Anything added via `.addStage()` runs **after** the base filter match and **before** projection/sort.
- If you `$group`/reshape documents, do it before `.project()` — or skip `.project()` and use `.addStage({ $project: {...} })` for full control over the new shape.
- If you add your own `$sort` via `.addStage()` _and_ also call `.sort()`, both stages are included (the builder's `.sort()` stage is always appended last in the base pipeline) — harmless but redundant. Prefer one or the other.

## Security

| Protection                        | Detail                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **NoSQL injection**               | Allowlist enforced on `.filter()`/`.sort()`/`.project()` via `.allowFields()`                                                 |
| **Banned operators**              | `$where`, `$expr`, `$function`, `$accumulator`, `$map`, `$reduce`, `$filter` rejected recursively, any depth, in client input |
| **Destructive stages**            | `$out` / `$merge` rejected in `.addStage()` / `.lookup()` sub-pipelines                                                       |
| **ReDoS**                         | `.globalSearch()` terms are regex-escaped before compilation                                                                  |
| **Oversized search**              | `?q=` capped at 200 characters                                                                                                |
| **Deep nesting DoS**              | Client filter object nesting capped at depth 5 (`sanitize()`)                                                                 |
| **Page size DoS**                 | `limit` hard-capped at `maxLimit` (default 100)                                                                               |
| **Sort abuse**                    | Sort fields hard-capped at 5                                                                                                  |
| **Runaway queries**               | `maxTimeMS` applied to the aggregation; `onSlowQuery` for observability                                                       |
| **Bad timezone input**            | Invalid IANA zone validated once at construction, falls back to default, never throws mid-query                               |
| **Server condition override**     | `.where()` / `.range()` conditions are merged last via `$and` — URL params can never override them                            |
| **Untrusted `.addStage()` input** | Not sanitized/allowlisted by design — documented as a trusted, developer-authored-only escape hatch                           |

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
```
