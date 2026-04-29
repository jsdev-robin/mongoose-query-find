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
  - [.filter()](#filter)
  - [.globalFilter()](#globalfilterfields-string)
  - [.sort()](#sort)
  - [.limitFields()](#limitfieldsdefaultfields-string)
  - [.populate()](#populatepath-string--populateoptions-select-string)
- [Terminal Method](#terminal-method)
  - [.paginate()](#paginate)
- [Query Parameter Reference](#query-parameter-reference)
- [Full Example (Express)](#full-example-express)
- [TypeScript Types](#typescript-types)
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
import QueryFind from 'mongoose-query-find';
import UserModel from './models/user';

const result = await new QueryFind(UserModel.find(), req.query)
  .filter()
  .globalFilter(['name', 'email'])
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
  "limit": 10
}
```

---

## Constructor

```ts
new QueryFind(query, queryString);
```

| Parameter     | Type                                | Description                                   |
| ------------- | ----------------------------------- | --------------------------------------------- |
| `query`       | `Query<TRawDocType[], TRawDocType>` | A Mongoose query, e.g. `Model.find()`         |
| `queryString` | `QueryParams`                       | The parsed URL query object, e.g. `req.query` |

---

## Builder Methods

All builder methods return `this`, so they are fully chainable in any order.

### `.filter()`

Parses the URL query string into a Mongoose filter. Automatically:

- Strips reserved keys (`page`, `limit`, `sort`, `fields`, `q`)
- Converts comparison operator names to MongoDB `$` syntax (`gt` → `$gt`, `lte` → `$lte`, etc.)
- Coerces string booleans to real booleans (`"true"` → `true`, `"false"` → `false`)
- Coerces date-like string values to `Date` instances for fields named `createdAt`, `updatedAt`, `deletedAt`, `date`, or `Date`

**Supported operators:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`

```
GET /users?age[gte]=18&isActive=true&role=admin
```

```ts
.filter()
// → { age: { $gte: 18 }, isActive: true, role: 'admin' }
```

---

### `.globalFilter(fields: string[])`

Adds a case-insensitive `$or` regex search across the specified fields when the `q` query parameter is present. If `q` is absent, this method is a no-op.

```
GET /users?q=john
```

```ts
.globalFilter(['name', 'email'])
// → { $or: [{ name: /john/i }, { email: /john/i }] }
```

---

### `.sort()`

Applies sort order from the `sort` query parameter. Prefix a field with `-` for descending order. Multiple fields are comma-separated.

```
GET /users?sort=-createdAt,name
```

```ts
.sort()
// → sorts by createdAt DESC, then name ASC
```

Defaults to `{ createdAt: -1 }` when the `sort` param is absent.

---

### `.limitFields(defaultFields?: string)`

Controls which fields are returned (projection). Uses the `fields` query param when present, otherwise falls back to `defaultFields`.

**Priority order:**

1. `?fields=` query param — always wins when present
2. `defaultFields` argument — used as fallback when no query param
3. No projection at all when both are absent (all fields returned)

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

Registers a populate directive. Can be called multiple times to populate multiple paths — each call appends to the internal list. All registered populates are applied inside `paginate()` after the `find` query is built, so core filter / sort / pagination logic is completely untouched.

Accepts the same arguments as Mongoose's own `.populate()`:

```ts
// Plain path string
.populate('author')

// Path + select string
.populate('author', 'name email')

// Full PopulateOptions object
.populate({ path: 'comments', select: 'text createdAt', match: { visible: true } })

// Multiple calls — each appends to the list
.populate('author')
.populate({ path: 'comments', select: 'text createdAt' })
```

---

## Terminal Method

### `.paginate()`

Executes the query and returns a `Promise<PaginatedResult<T>>`. Makes exactly two database round-trips:

1. `countDocuments` — counts total matching documents (uses index scan)
2. `find` — fetches the requested page with sort, skip, limit, projection, and any registered populates applied

```
GET /users?page=2&limit=20
```

**Returns:**

```ts
{
  data: T[];         // Documents for the current page
  total: number;     // Total matching documents across all pages
  page: number;      // Current page (auto-corrects to 1 if out of range)
  totalPages: number;
  limit: number;
}
```

> If the requested `page` exceeds `totalPages` (e.g. after a deletion), page `1` is returned automatically so the caller always receives valid data.

**Defaults:** `page=1`, `limit=10`

---

## Query Parameter Reference

| Parameter   | Example                   | Description                                       |
| ----------- | ------------------------- | ------------------------------------------------- |
| `page`      | `?page=3`                 | Page number (default: `1`, min: `1`)              |
| `limit`     | `?limit=25`               | Documents per page (default: `10`, min: `1`)      |
| `sort`      | `?sort=-createdAt,name`   | Sort fields; prefix `-` for descending            |
| `fields`    | `?fields=name,email`      | Comma-separated fields to include in the response |
| `q`         | `?q=john`                 | Global search term (used by `.globalFilter()`)    |
| _(any key)_ | `?role=admin&age[gte]=18` | Field-level filters processed by `.filter()`      |

---

## Full Example (Express)

```ts
import { Request, Response } from 'express';
import QueryFind from 'mongoose-query-find';
import UserModel from '../models/user';

export const getUsers = async (req: Request, res: Response) => {
  const result = await new QueryFind(UserModel.find(), req.query)
    .filter()
    .globalFilter(['name', 'email', 'username'])
    .sort()
    .limitFields('-password -__v')
    .populate('role', 'name permissions')
    .paginate();

  res.json({
    status: 'success',
    ...result,
  });
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

# Filter by date range
GET /users?createdAt[$gte]=2024-01-01&createdAt[$lte]=2024-12-31

# Combined: search + filter + sort + pagination
GET /users?q=john&role=editor&sort=-createdAt&page=1&limit=5
```

---

## TypeScript Types

Both types are exported and available for use in your own code:

```ts
import QueryFind, { QueryParams, PaginatedResult } from 'mongoose-query-find';
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
