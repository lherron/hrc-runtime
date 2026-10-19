# 4. HTTP API on the daemon socket

The daemon's HTTP surface on its unix socket. Every `hrc` verb and the SDK (`HrcClient`, package
`hrc-sdk`) ride it; ACP and the viewer are its other clients. About 130 `/v1/*` routes; this feature drives
the observation routes a consumer pages. Code: `packages/hrc-server/src/server-exact-routes.ts`,
`server-routing.ts`, `bounded-event-stream.ts`, `event-handlers.ts`. Contract: `docs/lifecycle-event-tail.md`.

## Sub-features

- `GET /v1/health` → `{"ok":true}`.
- `GET /v1/events/head` → `{hrcSeq, brokerCommit}`.
- `GET /v1/events/tail?limit=N[&beforeHrcSeq=S&ledgerIncarnationId=I][&<filters>]`: newest page in
  ascending `hrcSeq`, with `ledgerIncarnationId`, `headHrcSeq` (the global head, not the page's) and
  `truncated` (older matching rows exist). Filters: `hostSessionId`, `generation`, `scopeRef`, `laneRef`,
  `runtimeId`, `runId`, `category`, `eventKind`, `sourceRef`.
- A `scopeRef` read routes by the scope's home node first (T-10418, `federation/scope-read-routing.ts`): on a federated
  node, a tail for a scope homed elsewhere is forwarded and answers with header `x-hrc-home-node: <node>` and
  that node's `ledgerIncarnationId` and `headHrcSeq`; a local scope answers here with no header. A home that
  can't be resolved is a retryable 503 (`session_home_pending|unknown|unreachable`; source-read, not driven).
  `/v1/status` `.capabilities.federatedSessionRead` says the node does this.
- `GET /v1/sessions[?latestGeneration=true]`: a bare array of host sessions; `latestGeneration` keeps only each
  scope's newest generation (T-10832). `POST /v1/sessions/restart` is what `hrc restart` calls (feature 2).
- Refusals: `limit` outside 1..500 → 400 `malformed_request` ("limit must be between 1 and 500" for 501,
  "limit must be a safe integer greater than or equal to 1" for 0); `beforeHrcSeq` without the incarnation → 400;
  a stale or wrong incarnation → 409 `cursor_invalid` with expected/current ids and no events.
- Not driven here: `/v1/events/bounded-stream` (the forward stream), the write routes (they are driven
  through the CLI in features 2, 3 and 7), the federation peer routes (TCP listener, not this socket).

## How to get to it

`curl --unix-socket <socket> http://hrc/<route>`. Scratch socket: `/tmp/hv/<task>/run/hrc.sock`. Live socket
(read-only routes only): `~/praesidium/var/run/hrc/hrc.sock`.

## Driving it

```bash
S=/tmp/hv/<task>/run/hrc.sock
curl -s --unix-socket $S http://hrc/v1/health
curl -s --unix-socket $S 'http://hrc/v1/events/tail?limit=3' | jq -c '{seqs: [.events[].hrcSeq], ledgerIncarnationId, headHrcSeq, truncated}'
INC=<ledgerIncarnationId>; OLD=<oldest hrcSeq on that page>
curl -s --unix-socket $S "http://hrc/v1/events/tail?limit=3&beforeHrcSeq=$OLD&ledgerIncarnationId=$INC" | jq -c '{seqs: [.events[].hrcSeq], headHrcSeq, truncated}'
curl -s --unix-socket $S "http://hrc/v1/events/tail?limit=500&beforeHrcSeq=4&ledgerIncarnationId=$INC" | jq -c '{seqs: [.events[].hrcSeq], truncated}'   # [1,2,3], false
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/tail?limit=501'                                       # 400
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/tail?limit=0'                                         # 400
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/tail?limit=3&beforeHrcSeq=10'                         # 400
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/tail?limit=3&beforeHrcSeq=10&ledgerIncarnationId=bogus'  # 409
curl -s --unix-socket $S 'http://hrc/v1/events/tail?limit=5&eventKind=turn.completed' | jq -c '[.events[] | {hrcSeq, eventKind, runId}]'
curl -s --unix-socket $S http://hrc/v1/events/head
curl -s --unix-socket $S 'http://hrc/v1/sessions?latestGeneration=true' | jq -c '[.[] | {hostSessionId, generation, status}]'
L=~/praesidium/var/run/hrc/hrc.sock    # live, read-only: remote-homed scope vs local control
curl -s -D- -o /dev/null --unix-socket $L 'http://hrc/v1/events/tail?limit=1&scopeRef=agent:mable:project:hrc-runtime:task:minisvc' | grep -iE '^HTTP|x-hrc-home-node'
curl -s -D- -o /dev/null --unix-socket $L 'http://hrc/v1/events/tail?limit=1&scopeRef=agent:clod:project:hrc-runtime:task:<task>' | grep -iE '^HTTP|x-hrc-home-node'
```

## Gotchas

- The host part of the URL is ignored; `http://hrc/…` is a convention, not a name that must resolve.
- `/v1/federation/health` on the unix socket is `404 Not Found` (plain text, not JSON): peer routes live
  on the federation TCP listener. Read federation health through `hrc doctor` (feature 5). A `scopeRef`
  read on the socket can still be answered by a peer (Sub-features): on 2026-10-19 the minisvc tail came back
  from svc (`x-hrc-home-node: svc`, head 123941) while max3's own head was 3035766
  (`T-11363/05-placement-federation/drive.txt`). Don't page a remote scope with max3's incarnation.
- **`turn.completed` is per turn, not per HRC run.** A turn the broker takes without an HRC dispatch (typed
  in the pane, a participant's own prompt) has no `runId` since e822f2a9 (T-11306), so "one per run" holds
  only when every turn came through `start`/`send`/`turn` (source-read; this drive dispatched all six).
- `/v1/sessions` is a bare array; `.sessions` on it is a jq error.
- `headHrcSeq` stays the global head on a history page (59 on every page of the T-10297 drive, 46 on
  T-11363's); bound
  your paging by `truncated`, not by `headHrcSeq`.

## Proven when

Paging backwards from the newest page with the returned incarnation walks contiguous, ascending pages to
`truncated: false` at `hrcSeq` 1; the three refusals answer 400, 400 and 409 with the documented codes; an
`eventKind` filter returns only that kind, one `turn.completed` per run the scratch drove; on live a
remote-homed scope's tail carries `x-hrc-home-node` and the local control does not.

Driven 2026-10-19 (T-11363 upkeep) on installed d8451409, scratch `t-11363` (46 events in two contiguous
pages of 25, three `turn.completed` for three runs at that point) and live read-only for the routed tail:
`var/wrkq-artifacts/T-11363/04-http-api/drive.txt`, `05-placement-federation/drive.txt` (routed tail) and
`02-runtime-lifecycle/drive.txt` (`latestGeneration`).
