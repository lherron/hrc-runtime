# Federation peer protocol v1

HRC's federation listener is a dedicated tailnet-only HTTP server. It does not
reuse the Unix-socket HRC API router and exposes exactly these routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/federation/establish` | Authenticated authority-only establishment of a policy-born virgin scope on its named home. |
| `POST` | `/v1/federation/accept` | Durably and idempotently accept an epoch-fenced message envelope. |
| `POST` | `/v1/federation/locate` | Resolve `scopeRef` to binding authority, placement epoch, observed local presence, and birth provenance. |
| `GET` | `/v1/federation/health` | Return node liveness and peer-protocol capabilities on demand; optionally include this node's filtered runtime projection. |

All other paths return 404. In particular, `/v1/status`, `/v1/events`, and the
rest of HRC's control API are never exposed by this TCP listener.

## Version and authentication

Every request must provide both:

```http
Authorization: Bearer <peer token>
x-hrc-peer-protocol-version: 1.0
```

The receiver accepts additive minor-version differences within major version
1 and ignores unknown JSON fields. A missing or malformed version is HTTP 400.
An incompatible major is the visible HTTP 426 refusal
`incompatible_protocol_major`; it is never parsed as the local version.

Bearer tokens are loaded only from the node-local federation config. Missing
or unknown credentials return a generic HTTP 401 without reflecting candidate
or configured token material. Token values are wrapped in `PeerToken`, whose
string, JSON, inspection, and error projection is `[REDACTED]`.

## Dark-by-default listener config

No `peerListener` means no peer TCP listener. Enabling one requires a declared
node identity, at least one configured peer, and a concrete tailnet host:

```json
{
  "nodeId": "lab",
  "peers": {
    "svc": {
      "endpoint": "http://svc.example.ts.net:18493",
      "registryEndpoint": "http://svc.example.ts.net:18491",
      "token": "outbound-current",
      "acceptedTokens": ["inbound-current", "inbound-next"]
    }
  },
  "peerListener": {
    "bind": "http://lab.example.ts.net:18490"
  }
}
```

Each peer may expose two role-separated transport origins:

- `endpoint` is the peer-protocol origin and is used only for
  `/v1/federation/establish`, `/v1/federation/accept`, `/v1/federation/locate`, and
  `/v1/federation/health`.
- `registryEndpoint` is the optional binding-registry origin and is used only
  for `/v1/federation/registry/*`. When absent, registry clients fall back to
  `endpoint` for legacy or deliberately co-listened deployments.

The transport split does not select authority. `gate.registryHost` is the sole
explicit declaration of which node owns the binding registry. For backward
compatibility, when it is absent and exactly one peer is declared, that peer is
selected; multiple peers without `gate.registryHost` are refused as ambiguous.
A `registryEndpoint` on any peer never participates in selection or implies or
infers `registryHost`. Both origins authenticate the same peer identity with
the existing `token` and `acceptedTokens` rotation contract—there is no second
registry credential.

`registryEndpoint`, when present, is validated at daemon startup as a non-empty
`http`/`https` tailnet destination origin with an explicit port and specific
tailnet host. Embedded credentials, paths, queries, and fragments are refused
with a diagnostic naming `peers.<node>.registryEndpoint`. Status surfaces show
both origins but remain token-free.

`peerListener.bind` rejects wildcard, unspecified, loopback, LAN, and public
hosts at startup. Valid hosts are Tailscale IPv4 (`100.64.0.0/10`), Tailscale
IPv6 (`fd7a:115c:a1e0::/48`), or a specific `*.ts.net` name. Tailnet transport
provides encryption, so the bind URL uses `http:`.

The configuration remains flag-dark in source and must only be exercised with
isolated daemons until the federation summon gate is enforcing on every node
that will federate. Adding production `peerListener` config is a separate ops
step, not part of the listener implementation.

## Health, locate, and runtime projections

Health responses name the answering `nodeId`, its `startedAt`, the
`observedAt` timestamp for the projection, protocol version, and additive
capabilities. `GET /v1/federation/health?includeRuntimes=true` also returns
that node's local runtime rows. The normal runtime-list filters (`scope`,
`agent`, `task`, `status`, `transport`, `stale`, `olderThan`, and
`hostSessionId`) are accepted as query parameters. This is an additive use of
the existing health verb, not a fifth peer route; the listener still exposes
only establish, accept, locate, and health.

The additive health capability `establish: true` advertises support for the
authority-only establishment verb. An origin must treat an omitted capability,
an HTTP 404, or an endpoint that otherwise cannot speak the verb as the typed
non-retryable refusal `peer_upgrade_required`. It must never fall back to an
unfenced accept envelope.

The peer health handler never fans out. Aggregation belongs to the requesting
node's Unix-socket API, which probes configured peers concurrently with a
bounded timeout. `hrc runtime list --all-nodes` renders one explicitly labeled
node block per answer. A failed probe remains present as `unreachable`; when
that daemon has an earlier in-memory answer, the old rows remain visible with
their original `answeredAt` timestamp so staleness cannot masquerade as live
truth. `hrc doctor` and `hrc server status` request the same bounded health
observations on demand.

`hrc target locate` first resolves authority locally. When the authoritative
home is a configured remote node, the daemon makes exactly one authenticated
peer `locate` call to that home and attaches its node-local observation as
`peerResolution`. Peer-listener locate itself stays local-only, preventing
recursive fanout and preserving the bounded response contract.

## Live-tailnet test gate

Federation landing and release validation runs `just test-federation-live`.
That recipe sets `HRC_REQUIRE_LIVE_TAILNET_TESTS=1`, so absence of a tailnet
IPv4 interface fails every live federation file instead of silently skipping
it. Ordinary test runs may still skip on hosts without tailnet access, but emit
the greppable marker `HRC_LIVE_TAILNET_SKIP` with the affected filename.

## Token rotation

`token` is sent on outbound peer requests. `acceptedTokens` is the inbound
overlap set and defaults to `[token]`. Rotate without an authentication gap:

1. Add the new secret to every receiver's `acceptedTokens`; keep outbound
   `token` unchanged.
2. After receivers have reloaded, switch each sender's `token` to the new
   secret. Receivers temporarily accept old and new.
3. After all senders have switched, remove the old secret from
   `acceptedTokens`.

Tokens must remain unique between peer identities so authentication always
maps to exactly one `authenticatedNodeId`. The federation config file is
operator-managed, node-local, not git-synced, and expected to be mode `0600`.

## Remote policy establishment

Remote establishment is phase one of a two-phase delivery. It creates authority
only; ordinary epoch-fenced accept remains phase two and is the only phase that
inserts the message or mints/reuses a session.

An origin may enter this phase only when the shared placement resolver returns
`remote-establish` for an exact registry-unbound, summon-capable, implicit
request. The outcome is policy-born only. Child-birth credentials remain
node-local, federated bare-address claim birth remains refused, and neither
`explicit_local` nor the reserved `default_home_node = "local"` sentinel grants
remote establishment authority.

The authenticated request deliberately carries no placement assertion:

```json
{
  "scopeRef": "agent:scribe:project:hrc-runtime:task:T-06807",
  "intent": "implicit",
  "correlationId": "establish-msg-11111111-1111-4111-8111-111111111111"
}
```

Only the canonical `scopeRef`, the literal implicit intent, and an opaque
correlation ID cross the peer boundary. In particular, the origin never sends a
candidate home, epoch, policy provenance, birth credential, child authority, or
origin-side placement path.

After node-level bearer authentication, the receiver independently evaluates
the shared summon-gate decision from its current facts in this order:

1. retirement fence;
2. active local ledger;
3. collective registry;
4. receiver-local placement policy and materialization capability.

For a registry-unbound policy birth, the receiver must find a named policy rule
that designates its concrete node ID. It must not reinterpret the reserved
`"local"` sentinel as itself. A child, claim, explicit-local, undeclared, or
other birth class is a typed refusal. If authority is allowed, the receiver
calls the existing registry-first establishment operation: the epoch-1 registry
CAS happens before the local ledger install. That CAS is the one and only
advertisement; the peer protocol adds no second advertise record or summon
ledger.

Successful responses return the exact resulting binding and echo the
correlation ID. `established` means this attempt created or completed the local
authority; `existing` means a retry or race found the registry already bound:

```json
{
  "ok": true,
  "protocolVersion": "1.0",
  "correlationId": "establish-msg-11111111-1111-4111-8111-111111111111",
  "outcome": "established",
  "binding": {
    "scopeRef": "agent:scribe:project:hrc-runtime:task:T-06807",
    "homeNodeId": "max3",
    "placementEpoch": 1,
    "birthClass": "policy-born",
    "authorityProvenance": { "kind": "policy", "source": "default_home_node" },
    "establishmentProvenance": "default_home_node",
    "createdAt": "2026-07-22T20:00:00.000Z",
    "updatedAt": "2026-07-22T20:00:00.000Z"
  }
}
```

The collective registry arbitrates concurrent first birth. A loser installs no
local authority and returns the stored winning binding. The origin then
re-resolves through the registry and routes to that winner. A receiver whose
current policy does not name itself refuses with `pin-mismatch` /
`routed-elsewhere`; the origin does not chase a suggested peer. Once a scope is
bound, the binding wins over later policy skew.

Peer-wire refusals are closed and safe:

```json
{
  "ok": false,
  "protocolVersion": "1.0",
  "error": {
    "code": "stale_context",
    "message": "remote policy establishment refused",
    "reason": "routed-elsewhere",
    "retryable": false,
    "homeNodeId": "max3",
    "context": {
      "scopeRef": "agent:scribe:project:hrc-runtime:task:T-06807",
      "correlationId": "establish-msg-11111111-1111-4111-8111-111111111111"
    }
  }
}
```

Policy, retirement, birth-class, capability, and authority refusals use HTTP
409 with public code `stale_context` and a stable `reason`. Registry or named
home unavailability uses HTTP 503 with `runtime_unavailable`,
`retryable: true`, and `homeNodeId`. Full diagnostics stay in the receiver log;
the peer response contains only safe context. Missing protocol support maps to
the non-retryable reason `peer_upgrade_required`. Nothing on this path becomes
`internal_error` or a bare HTTP 500.

The origin MUST consult the registry again after a successful establishment
response. Only the re-resolved binding may construct the ordinary fenced
accept envelope. Establishment never inserts the message, starts a runtime,
mints a session, or grants the origin authority.

## Accept envelope and ACK

The request body is a tolerant wrapper. Unknown wrapper, envelope, and
delivery fields are ignored within protocol major 1:

```json
{
  "envelope": {
    "protocolVersion": "1.0",
    "messageId": "msg-11111111-1111-4111-8111-111111111111",
    "kind": "dm",
    "phase": "request",
    "from": { "kind": "session", "sessionRef": "agent:mable:project:hrc-runtime:task:minisvc" },
    "to": { "kind": "session", "sessionRef": "agent:cody:project:hrc-runtime:task:T-06618" },
    "body": "hello from svc",
    "rootMessageId": "msg-11111111-1111-4111-8111-111111111111",
    "expected": { "homeNodeId": "lab", "placementEpoch": 4 }
  }
}
```

`replyToMessageId` is optional; `rootMessageId` is always explicit. Optional
`delivery` context carries runtime intent and other local summon inputs, but
never `wait` (origin-local) or a birth credential (child birth is node-local).

The receiver checks its local placement ledger before inserting a new message.
A newer tuple returns `stale_placement` with a `redirect` containing the newer
`homeNodeId` and `placementEpoch`. A message ID already durably accepted ACKs
as `duplicate` even if placement changed afterward; this is what makes a crash
between insert and ACK converge on retry.

Successful results ACK `accepted` or `duplicate` with `messageId`. The first
ACK is built only after the SQLite transaction commits; local summon/queue
behavior is queued after that ACK and uses the same delivery function as a
local semantic DM. Each node allocates its own `message_seq`; the origin's
sequence is never copied into the envelope.

At the origin, the ACK consumer records `(requestMessageId,
acceptedByNodeId, acceptedEpoch)` in `federation_accepted_requests`. That record
is idempotent and is the response fence.

## Bilateral transcripts and response fencing

The origin inserts the request before it creates the outbox row; the accepting
node inserts the same `messageId` before ACK. Consequently both endpoints can
resolve `replyToMessageId` through their local message repository.

Responses follow the accepting request's recorded ingress node, not the
current placement of the reply target. On receipt, a response is accepted only
when its `replyToMessageId` names a local request whose accepted-request record
names the authenticated sending node. Duplicate response delivery is
idempotent after the same validation.

Current placement and the response envelope's expected epoch are deliberately
not consulted for response completion. Placement still fences new request
acceptance and summon authority; the accepted-request record independently
fences completion. A response delayed across a placement rebind therefore
still lands in the bilateral transcript.

## Origin outbox and retry lifecycle

An outbound transcript row remains the owning-node message queue. Its network
delivery is a separate `federation_outbox_deliveries` row keyed back to that
message; target execution fields are never used for peer retry state.

For `remote-establish`, authority establishment is the first typed stage of
that same delivery row. The row initially retains the durable message and the
candidate peer while its stage is `establishing`; it does not create a separate
summon job or ledger. On a successful establishment response, the origin
re-consults the registry and atomically advances the same row to `delivering`
with the winning binding's epoch-fenced envelope. A crash before the advance
retries the idempotent establish request; a crash after it retries ordinary
accept. Peer sleep therefore remains covered by the existing 28-day retry
window.

Queued establishment is normal delivery state, not a caller-visible error. A
retryable establishment refusal follows the existing outbox schedule. Only a
non-retryable refusal or exhausted retry window becomes a dead letter and the
typed terminal error observed by a waiting caller.

The origin attempts immediately, then retries exponentially from one second up
to a six-hour cap. The automatic retry window is 28 days so a closed laptop is
normal peer sleep, not a short outage. Transport failures are durably visible
as `peer_unreachable`; retryable protocol refusals use `retry_scheduled`.
Successful `accepted` and `duplicate` ACKs both settle as `delivered`.

At the end of the retry window, or after a non-retryable refusal, the delivery
becomes `dead_letter`. This is expected, terminal only for automatic attempts,
and replayable. The Unix-socket API exposes:

- `GET /v1/federation/outbox?messageId=<id>&peerNodeId=<node>&state=<csv>` —
  filterable durable delivery state.
- `POST /v1/federation/outbox/replay` with `{ "deliveryId": "..." }` — replay
  one dead-letter delivery with a fresh 28-day retry window.
- `POST /v1/federation/outbox/replay-peer` with `{ "peerNodeId": "..." }` —
  replay every current dead-letter for one peer. Repeating the operation cannot
  replay rows already moved back to `pending`.
- `POST /v1/federation/outbox/drop` with `{ "deliveryId": "..." }` — delete one
  terminal dead-letter. Active rows cannot be dropped because a send may
  already be in flight.

The corresponding operator commands are `hrc federation outbox list`,
`replay <delivery-id>`, `replay --all --peer <node>`, and
`drop <delivery-id> --yes`. Human list output groups by peer and shows age, attempts, replay count,
and the last error. `hrc doctor` reports pending and dead-letter counts per peer
as expected sleep-envelope state rather than declaring a sleeping peer an
outage.

`hrcchat dm --wait response` sends the request without a server-coupled wait,
then waits only on its local daemon's Unix-socket API. The local wait observes
either the bilateral response row or the request's durable outbox row reaching
`dead_letter`; peer accept requests remain bounded one-shot attempts owned by
the outbox and are never held open by the CLI wait.
