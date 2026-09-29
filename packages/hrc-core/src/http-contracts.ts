/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 *
 * Contracts are grouped by domain in sibling modules and re-exported here.
 */
export * from './http-contracts-dispatch.js'
export * from './http-contracts-runtime.js'
export * from './http-contracts-surfaces.js'
