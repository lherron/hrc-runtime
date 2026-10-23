/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 *
 * Contracts are grouped by domain in sibling modules and re-exported here.
 */
/**
 * Observational caller label on every HRC HTTP request (T-11541). It carries no
 * authority: the daemon only records it, sanitized, as the `client` of a
 * request metric. The SDK transport sets it; raw callers may set it too.
 */
export const HRC_CLIENT_HEADER = 'x-hrc-client'

export * from './http-contracts-dispatch.js'
export * from './http-contracts-runtime.js'
export * from './http-contracts-surfaces.js'
