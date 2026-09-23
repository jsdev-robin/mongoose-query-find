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
