# Federation peer HTTP contract

The peer listener is a dedicated HTTP surface on an explicitly configured
tailnet address. Every request requires a bearer token matching a configured
peer. Missing or invalid authentication returns `401 unauthorized`; unmatched
routes return `404 not_found`.

Federation v1.3 has no protocol-version negotiation. Peers do not send or
require a federation-version header, health and operation responses do not
carry a protocol version, and an obsolete version header is ignored. Feature
availability is discovered from health capabilities and route presence.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/federation/health` | Health, observation time, and additive capabilities; optional runtime projection. |
| `POST` | `/v1/federation/locate` | Resolve one scope using the receiver's local placement view. |
| `POST` | `/v1/federation/establish` | Ask the selected home to perform an ordinary implicit establishment. |
| `POST` | `/v1/federation/roster-start` | Start through the authenticated home-node roster surface. |
| `POST` | `/v1/federation/exact-start` | Provision one exact scope on its authoritative home. |
| `GET` | `/v1/sessions/page` | Read a bounded node-local session page. |
| `GET` | `/v1/sessions/facets` | Read node-local session facets. |
| `GET` | `/v1/sessions/get` | Read the home-node continuity, identity, facts and resolved metadata without creating a session. |
| `GET` / `PATCH` | `/v1/sessions/metadata` | Read or patch API metadata on the continuity home; cosmetic writes need no additional authority check. |
| `POST` | `/v1/sessions/resolve` | Read-only resolve on the scope home (T-10418). The body must be exactly `{ sessionRef, create?: false }`; `create: true`, `summonIntent` or `runtimeIntent` is `403 peer_read_only` before any create path. |
| `GET` | `/v1/events/tail` | Scope-filtered bounded tail page from the home ledger (T-10418); `scopeRef` required. |
| `GET` | `/v1/events/bounded-stream` | Scope-filtered bounded follow on the home ledger (T-10418); `scopeRef` required. |
| `GET` | `/v1/runs` | Scope-filtered run list on the home (T-10418); `scopeRef` required. |
| `POST` | `/v1/federation/history/replicate` | Replicate one collective-history record. |
| `POST` | `/v1/federation/history/query` | Query collective history. |
| `POST` | `/v1/federation/history/checkpoint` | Record a history checkpoint. |
| `POST` | `/v1/federation/server-lifecycle` | Attested remote HRC restart (T-09861); advertised by the `serverLifecycle` health capability. |

The four T-10418 session-read routes are dispatched `localOnly` on the home, so a
forwarded read never takes a second hop, and the three event/run routes refuse
any non-`GET` method with `403 peer_read_only`. The origin relays the bounded
stream record by record (see `hrc-runtime.bounded-lifecycle-event-observation`)
and tags forwarded answers with `x-hrc-home-node`. Health advertises the
`federatedSessionRead` capability.

The old federation message accept routes are deleted. Cross-node agent talk is
carried by the shared wrkq ledger; the peer surface retains placement, birth,
summon, locate, session projection, and collective-history responsibilities.

## Placement contract

An established binding is only:

```json
{
  "scopeRef": "agent:cody:project:hrc-runtime:task:T-07032",
  "homeNodeId": "svc",
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z"
}
```

There is no placement epoch, birth class, establishment provenance, prior-home
field, or movement transition. A receiver that is not the established home
refuses or redirects discovery to the current home. Registry failure is never
collapsed into "unbound".

Retirement is a local daemon operation, not a peer route. The authenticated old
home durably fences itself before conditionally deleting its registry row; see
[Federation ordered retirement](federation-registry-retirement.md).

## Error model

Malformed bodies return `400 invalid_request`. A missing optional capability
returns a route-appropriate `404` refusal (for example `peer_upgrade_required`
on `server-lifecycle`). Temporary authority or runtime
failures return a structured retryable refusal. Unexpected handler failures are
redacted to `500 internal_error`; tokens and request-controlled details are not
reflected.
