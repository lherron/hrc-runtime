// T-01866 — harness-broker/0.1 is DECOMMISSIONED. HRC negotiates, persists, and
// validates ONLY harness-broker/0.2 for every harness-broker runtime. This is the
// single active protocol-version constant; there is no v0.1 constant and no
// activation/escape-hatch surface that can resurrect a legacy stdio route.
export const BROKER_PROTOCOL_VERSION = 'harness-broker/0.2'

// Wire transports (NOT protocol versions). The durable leased-tmux route rides the
// Unix socket. BROKER_TRANSPORT (stdio) remains the runtime-state endpoint default
// for the rare non-durable row (a pre-created/legacy client passed by an
// out-of-scope caller); it carries NO protocolVersion field, so a stdio endpoint
// can never masquerade as a durable v0.2 endpoint.
export const BROKER_TRANSPORT_UNIX = 'unix-jsonrpc-ndjson'
export const BROKER_TRANSPORT = 'stdio-jsonrpc-ndjson'
