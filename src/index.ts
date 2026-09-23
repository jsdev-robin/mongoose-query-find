// Classes + factory
export { QueryAggregate } from './aggregate';
export { QueryAnalytics } from './analytics';
export { QueryFind, queryFind } from './find';

// Shared types (defined identically in both files — sourced from ./find to avoid duplicate-export conflicts)
export type { PaginatedResult, QueryParams } from './find';

// QueryFind-only types & errors
export { QueryFindError, QueryFindValidationError } from './find';
export type {
  SlowQueryInfo as FindSlowQueryInfo,
  QueryFindOptions,
} from './find';

// QueryAggregate-only types & errors
export {
  QueryAggregateError,
  QueryAggregateValidationError,
} from './aggregate';
export type {
  SlowQueryInfo as AggregateSlowQueryInfo,
  LookupOptions,
  QueryAggregateOptions,
  RangePreset,
} from './aggregate';

// QueryAnalytics-only types & errors
export { QueryAnalyticsError } from './analytics';
export type {
  StatSpec as AnalyticsStatSpec,
  BreakdownRow,
  CohortRetentionOptions,
  CohortRow,
  ComparePreset,
  CompareResult,
  FunnelResult,
  FunnelStep,
  Interval,
  OutlierRow,
  QueryAnalyticsOptions,
  RankedBreakdownRow,
  SessionizeOptions,
  SessionSummary,
  TimeSeriesPoint,
} from './analytics';
