# mongoose-query-find

[![npm version](https://img.shields.io/npm/v/mongoose-query-find)](https://www.npmjs.com/package/mongoose-query-find)
[![license](https://img.shields.io/npm/l/mongoose-query-find)](https://github.com/jsdev-robin/mongoose-query-find/blob/main/LICENSE)
[![mongoose peer](https://img.shields.io/badge/mongoose-%5E8%20%7C%7C%20%5E9-brightgreen)](https://mongoosejs.com)

A fluent, chainable query builder for Mongoose that handles filtering, global search, sorting, field projection, population, and pagination — all driven directly from URL query parameters with zero boilerplate.

---

## Table of Contents

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
