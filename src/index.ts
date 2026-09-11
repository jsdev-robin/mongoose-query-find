// Classes + factory
export { QueryFind, queryFind } from './find';
export { QueryAggregate } from './aggregate';

// Shared types (defined identically in both files — sourced from ./find to avoid duplicate-export conflicts)
export type { QueryParams, PaginatedResult } from './find';

// QueryFind-only types & errors
export type { QueryFindOptions, SlowQueryInfo as FindSlowQueryInfo } from './find';
export { QueryFindError, QueryFindValidationError } from './find';

// QueryAggregate-only types & errors
export type {
  QueryAggregateOptions,
  LookupOptions,
  RangePreset,
  SlowQueryInfo as AggregateSlowQueryInfo,
} from './aggregate';
export { QueryAggregateError, QueryAggregateValidationError } from './aggregate';