export const BROKER_PROTOCOL_VERSION = 'harness-broker/0.1'
export const BROKER_TRANSPORT = 'stdio-jsonrpc-ndjson'

// T-01810 (T-01801 Phase 1) — protocol v2 superset of v1 carried over a
// Unix-domain socket for the durable interactive route (contract C-03078).
// These are ADDITIVE: the headless stdio route stays pinned to the v1/stdio
// consts above; do NOT replace those globally.
export const BROKER_PROTOCOL_VERSION_V2 = 'harness-broker/0.2'
export const BROKER_TRANSPORT_UNIX = 'unix-jsonrpc-ndjson'
