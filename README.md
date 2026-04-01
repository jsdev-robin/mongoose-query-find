# mongoose-query-find

> A TypeScript utility for Mongoose that simplifies building dynamic, chainable queries with filtering, global search, sorting, field selection, and pagination.

[![npm version](https://img.shields.io/npm/v/mongoose-query-find.svg)](https://www.npmjs.com/package/mongoose-query-find)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.2-blue)](https://www.typescriptlang.org/)
[![mongoose](https://img.shields.io/badge/mongoose-%5E8%20%7C%7C%20%5E9-green)](https://mongoosejs.com/)

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [filter()](#filter)
  - [globalFilter(fields)](#globalfilterfields)
  - [sort()](#sort)
  - [limitFields()](#limitfields)
  - [paginate()](#paginate)
  - [exec()](#exec)
- [Query String Parameters](#query-string-parameters)
- [Examples](#examples)
- [License](#license)

---

## Features

- **Advanced Filtering** — Supports all MongoDB comparison, logical, and element operators via query string
- **Global Search** — Search across multiple fields simultaneously using `$or` with regex
- **Sorting** — Sort by one or multiple fields, ascending or descending
- **Field Limiting** — Select or exclude specific fields from results
- **Pagination** — Built-in page/limit handling with sensible defaults
- **Chainable API** — Fluent builder pattern for clean, readable query construction
- **Fully Typed** — Written in TypeScript with generics for strong type safety

---

## Installation

```bash
npm install mongoose-query-find
```

> **Peer dependency:** Requires `mongoose@^8` or `mongoose@^9`.

---

## Quick Start

```typescript
import QueryFind from 'mongoose-query-find';
import { Request, Response } from 'express';
import Product from './models/Product';

export const getProducts = async (req: Request, res: Response) => {
  const features = new QueryFind(Product.find(), req.query)
    .filter()
    .sort()
    .limitFields()
    .paginate();

  const products = await features.exec();

  res.json({ results: products.length, data: products });
};
```

---

## API Reference

### `new QueryFind(query, queryString)`

| Parameter     | Type            | Description                                   |
| ------------- | --------------- | --------------------------------------------- |
| `query`       | `Query<T[], T>` | A Mongoose query object (e.g. `Model.find()`) |
| `queryString` | `QueryParams`   | Parsed query string from the request          |

---

### `filter()`

Applies field-level filtering from the query string. Automatically prepends `$` to MongoDB operators and wraps plain string values in a case-insensitive regex.

**Supported operators:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `regex`, `exists`, `all`, `size`, `elemMatch`, `type`, `mod`, `not`, `and`, `or`, `nor`, `text`, `where`, `geoWithin`, `geoIntersects`, `near`, `nearSphere`, `expr`, `jsonSchema`, `bitsAllClear`, `bitsAllSet`, `bitsAnyClear`, `bitsAnySet`, `rand`

**Example URL:**

```
GET /api/products?price[gte]=100&category=electronics
```

---

### `globalFilter(fields)`

Performs a global search across the specified fields using the `q` query parameter with case-insensitive regex.

| Parameter | Type       | Description                           |
| --------- | ---------- | ------------------------------------- |
| `fields`  | `string[]` | Array of field names to search across |

**Example:**

```typescript
new QueryFind(Product.find(), req.query)
  .globalFilter(['name', 'description', 'brand'])
  .paginate();
```

**Example URL:**

```
GET /api/products?q=wireless+headphones
```

---

### `sort()`

Sorts results based on the `sort` query parameter. Multiple fields can be comma-separated. Defaults to `-createdAt` (newest first) if no sort is specified.

**Example URLs:**

```
GET /api/products?sort=price           # ascending by price
GET /api/products?sort=-price          # descending by price
GET /api/products?sort=category,-price # category asc, price desc
```

---

### `limitFields()`

Selects specific fields to include or exclude using the `fields` query parameter. Defaults to excluding `__v`.

**Example URLs:**

```
GET /api/products?fields=name,price,category   # include only these fields
GET /api/products?fields=-description,-__v     # exclude these fields
```

---

### `paginate()`

Applies skip/limit pagination using `page` and `limit` query parameters.

| Parameter | Default | Description                |
| --------- | ------- | -------------------------- |
| `page`    | `1`     | Page number (1-indexed)    |
| `limit`   | `100`   | Number of results per page |

**Example URL:**

```
GET /api/products?page=2&limit=20
```

---

### `exec()`

Executes the built query and returns a `Promise<T[]>`.

```typescript
const results = await features.exec();
```

---

## Query String Parameters

| Parameter           | Description                     | Example              |
| ------------------- | ------------------------------- | -------------------- |
| `q`                 | Global search term              | `?q=laptop`          |
| `sort`              | Comma-separated sort fields     | `?sort=-price,name`  |
| `fields`            | Comma-separated field selection | `?fields=name,price` |
| `page`              | Page number for pagination      | `?page=3`            |
| `limit`             | Results per page                | `?limit=25`          |
| `[field]`           | Filter by any document field    | `?brand=apple`       |
| `[field][operator]` | MongoDB operator filter         | `?price[gte]=500`    |

---

## Examples

### Combined Usage

```typescript
// GET /api/products?q=phone&price[gte]=200&sort=-createdAt&fields=name,price&page=1&limit=10

const features = new QueryFind(Product.find(), req.query)
  .globalFilter(['name', 'description'])
  .filter()
  .sort()
  .limitFields()
  .paginate();

const products = await features.exec();
```

### Filtering with Operators

```
GET /api/products?price[gte]=100&price[lte]=500&stock[gt]=0
```

```typescript
// Equivalent to:
Product.find({ price: { $gte: 100, $lte: 500 }, stock: { $gt: 0 } });
```

### Pagination

```
GET /api/products?page=2&limit=15
```

Skips the first 15 results and returns the next 15.

---

## License

[ISC](https://opensource.org/licenses/ISC) © [jsdev.robin@gmail.com](mailto:jsdev.robin@gmail.com)
