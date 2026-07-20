# Federation peer protocol v1

HRC's federation listener is a dedicated tailnet-only HTTP server. It does not
reuse the Unix-socket HRC API router and exposes exactly these routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/federation/accept` | Pass an envelope to the injected durable receiver. Until T-06618 supplies that receiver, this visibly refuses with HTTP 501 and `accept_not_enabled`. |
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

## Accept seam for T-06618

The request body is a tolerant wrapper:

```json
{ "envelope": { "messageId": "..." } }
```

After authentication and major-version validation, HRC passes
`authenticatedNodeId`, the caller's protocol version, and the opaque envelope
record to `peerAcceptHandler`. T-06618 owns envelope validation, durable
idempotent insertion, and the final accepted/duplicate semantics. Successful
results are returned as an ACK containing `outcome` and `messageId`; typed
receiver refusals carry a code and retryability flag.
