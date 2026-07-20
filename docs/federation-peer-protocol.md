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
      "endpoint": "http://svc.example.ts.net:18490",
      "token": "outbound-current",
      "acceptedTokens": ["inbound-current", "inbound-next"]
    }
  },
  "peerListener": {
    "bind": "http://lab.example.ts.net:18490"
  }
}
```

`peerListener.bind` rejects wildcard, unspecified, loopback, LAN, and public
hosts at startup. Valid hosts are Tailscale IPv4 (`100.64.0.0/10`), Tailscale
IPv6 (`fd7a:115c:a1e0::/48`), or a specific `*.ts.net` name. Tailnet transport
provides encryption, so the bind URL uses `http:`.

The configuration remains flag-dark in source and must only be exercised with
isolated daemons until the federation summon gate is enforcing on every node
that will federate. Adding production `peerListener` config is a separate ops
step, not part of the listener implementation.

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
is idempotent and is the response-fencing input for the next federation slice.
