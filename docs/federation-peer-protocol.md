# Federation peer protocol v1

HRC's federation listener is a dedicated tailnet-only HTTP server. It does not
reuse the Unix-socket HRC API router and exposes exactly these routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/federation/accept` | Durably and idempotently accept an epoch-fenced message envelope. |
| `POST` | `/v1/federation/locate` | Resolve `scopeRef` to binding authority, placement epoch, observed local presence, and birth provenance. |
| `GET` | `/v1/federation/health` | Return node liveness and peer-protocol capabilities on demand. |

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
  `/v1/federation/accept`, `/v1/federation/locate`, and
  `/v1/federation/health`.
- `registryEndpoint` is the optional binding-registry origin and is used only
  for `/v1/federation/registry/*`. When absent, registry clients fall back to
  `endpoint` for legacy or deliberately co-listened deployments.

The transport split does not select authority. `gate.registryHost` remains the
sole declaration of which node owns the binding registry; a
`registryEndpoint` on any peer never implies or infers `registryHost`. Both
origins authenticate the same peer identity with the existing `token` and
`acceptedTokens` rotation contract—there is no second registry credential.

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

The origin attempts immediately, then retries exponentially from one second up
to a six-hour cap. The automatic retry window is 28 days so a closed laptop is
normal peer sleep, not a short outage. Transport failures are durably visible
as `peer_unreachable`; retryable protocol refusals use `retry_scheduled`.
Successful `accepted` and `duplicate` ACKs both settle as `delivered`.

At the end of the retry window, or after a non-retryable refusal, the delivery
becomes `dead_letter`. This is expected, terminal only for automatic attempts,
and replayable. The Unix-socket API exposes the minimal F1 seams:

- `GET /v1/federation/outbox?messageId=<id>` — raw durable delivery state.
- `POST /v1/federation/outbox/replay` with `{ "deliveryId": "..." }` — replay
  one dead-letter delivery with a fresh 28-day retry window.

The polished list/bulk replay/drop controls and doctor projection remain the F3
operator-controls slice.

`hrcchat dm --wait response` sends the request without a server-coupled wait,
then waits only on its local daemon's Unix-socket API. The local wait observes
either the bilateral response row or the request's durable outbox row reaching
`dead_letter`; peer accept requests remain bounded one-shot attempts owned by
the outbox and are never held open by the CLI wait.
