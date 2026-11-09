# 4. HTTP API on the daemon socket

The daemon's HTTP surface on its unix socket, served by `rusthrc server serve`. Every native `hrc` verb rides it
(serve.log `client: rusthrc/0.1.0`), the Bun passthrough verbs too (`hrc-cli/0.1.0`), and the harness broker
(`harness-broker/0.1.0`); ACP and the viewer are its other clients; the hosted kernel enters the dispatcher
in-process. 103 method+path routes at 846648d8 (101 at 9861ae0e, plus `GET /v1/doctor` and `GET
/v1/broker-stats`, 2c947087): 87 literals in `implemented()`, the `/v1/sessions/by-host/` prefix,
`GET /v1/runtimes/<id>/seat`, `GET|PUT /v1/sessions/work`, `PATCH /v1/sessions/metadata`, 5 `GET /v1/events*`, 4
annotation routes (6 of them, the seat-handoffs and sessions/work routes, are prae-rev1's). This feature drives the
observation routes a consumer pages. Code: `crates/hrc-native/src/server.rs` (`dispatch_inner` :448,
`implemented` :812), `server/projection/{lifecycle_events,streams}.rs`, `server/placement/federation/routing.rs`,
`server/front/proxy.rs`, `crates/hrc-store/src/events.rs`. Contract: `docs/lifecycle-event-tail.md`.

## Sub-features

- `GET /v1/health` → `{"ok":true}`.
- `GET /v1/events/head` → `{hrcSeq, brokerCommit}` (`{"hrcSeq":124,"brokerCommit":106}`, 2026-11-02, T-12291).
- `GET /v1/events/tail?limit=N[&beforeHrcSeq=S&ledgerIncarnationId=I][&<filters>]`: newest page in
  ascending `hrcSeq`, with `ledgerIncarnationId`, `headHrcSeq` (the global head, not the page's) and
  `truncated` (older matching rows exist). Filters: `hostSessionId`, `generation`, `scopeRef`, `laneRef`,
  `runtimeId`, `runId`, `category`, `eventKind`, `sourceRef` (lifecycle_events.rs:65-90, tail :141-173).
  Since 84dfd19d `category` and `eventKind` each take a comma list, and with both a row passes if it matches
  **either**: `category=session&eventKind=turn.completed` returned `session.*` rows and `turn.completed` rows
  (2026-11-09, `T-12756/04-http-api/drive-extra.txt`). An empty list (`eventKind=,`, `category=,`) is 400
  "eventKind|category must name at least one value".
- A `scopeRef` read routes by the scope's home node before any validation (T-10418, `federation/routing.rs`
  `scope_of` :37): a scope homed elsewhere answers with `x-hrc-home-node: <node>` and that node's incarnation and
  head; a local one answers here with no header (live, 2026-11-02, T-12291: minisvc → `svc`, the T-12291 seat →
  none). An unresolvable home is a retryable 503 `session_home_pending|unknown|unreachable|malformed`, and `GET
  /v1/runs`, bounded-stream, `sessions/get|metadata|work|annotations` and `POST /v1/sessions/resolve` route too
  (source-only, 2026-11-02: routing.rs:52-100, :133-166, :255). `.capabilities.federatedSessionRead` is hard-coded
  `true` (server.rs:1062). `localOnly=true` on `GET /v1/sessions/get|annotations` skips home routing on the unix
  socket: live minisvc `sessions/get` answered `x-hrc-home-node: svc` without it and no header with it
  (2026-11-09); the peer listener refuses it 403 `local_only_forbidden` (source-only: peer_listener.rs:209-225).
- `GET /v1/events/page?afterSeq=S&limit=N[&ledgerIncarnationId=I]` (T-11441, the kernel's forward reader):
  `{ledgerIncarnationId, head, rows, scannedThrough}`, rows ascending from `afterSeq+1`; `scannedThrough` is the
  last row on a full page (`afterSeq=0&limit=5` → 5), else `head`. `afterSeq` is required, `limit` is 1..1000, a
  wrong incarnation is 409 `cursor_invalid` (2026-11-02, T-12291). It is not scope-routed, and `head` is the
  allocated sequence (`sqlite_sequence`), which can exceed the tail's `MAX(hrc_seq)` after a delete (source-only,
  2026-11-02: routing.rs:52, crates/hrc-store/src/events.rs:17-27,68-82); equal on the drive (124/124).
- Unserved routes answer Bun's plain-text `404 Not Found` and log one serve.log line each:
  `route.not_served {method, path, servedBy: "native", reason: "not-served-natively-no-bun-socket"}`
  (`server/front/proxy.rs:20-46`). Driven 2026-11-02 for the retired `/v1/registrations/gc`, `/v1/bridges`,
  `/v1/launches` and the never-ported Bun routes `/v1/messages/wait`, `/v1/in-flight-input`,
  `/v1/runtimes/capture/release` (6 × 404, 6 lines). Native 404s any unimplemented method+path, so a GET suffices.
- `GET /v1/sessions[?latestGeneration=true]`: a bare array of host sessions; `latestGeneration` keeps only each
  scope's newest generation (T-10832; one row, gen 4 `active`, 2026-11-02). `POST /v1/sessions/restart` is what
  `~/.bun/bin/hrc restart` calls (feature 2).
- Refusals (`malformed_request` 400 unless noted, 2026-11-02, T-12291): no `limit` → "limit is required"; 501 →
  "limit must be between 1 and 500"; 0 → "limit must be a safe integer greater than or equal to 1"; `generation=x`
  → "generation must be a non-negative integer"; `beforeHrcSeq` without the incarnation → "beforeHrcSeq requires
  the ledgerIncarnationId it was minted against"; a wrong incarnation → 409 `cursor_invalid` "event ledger
  incarnation is no longer current" with `detail {expectedLedgerIncarnationId, currentLedgerIncarnationId}` and no
  events. Page: 1001 → "limit must be between 1 and 1000"; no `afterSeq` → "afterSeq is required".
- `GET /v1/events?limit=N` is bounded and chunked since 02161fee: `limit=2` gave 2 lines, `limit=0` 400
  (2026-11-09). `GET /v1/runtimes?omitState=true` drops `runtimeStateJson` from every row
  (`capabilities.runtimeListOmitState: true`; no CLI flag). `GET /v1/doctor` answers the doctor rows (feature 1);
  `GET /v1/broker-stats` needs a selector (400 bare; `monitor stats` calls it, feature 3).
- Not driven here: `/v1/events/bounded-stream` (the forward stream), the write routes (driven through the CLI in
  features 2, 3 and 7), the federation peer routes (TCP listener, not this socket).

## How to get to it

`curl --unix-socket <socket> http://hrc/<route>`. Scratch socket (native by default): `/tmp/hv/<task>/run/hrc.sock`.
Live socket (read-only routes only): `~/praesidium/var/run/hrc/hrc.sock`, also rusthrc.

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
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/tail?'                                                # 400 limit is required
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/tail?limit=3&generation=x'                            # 400
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/tail?limit=3&beforeHrcSeq=10'                         # 400
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/tail?limit=3&beforeHrcSeq=10&ledgerIncarnationId=bogus'  # 409
curl -s --unix-socket $S 'http://hrc/v1/events/tail?limit=50&eventKind=turn.completed' | jq -c '{truncated, rows: [.events[] | {hrcSeq, runId}]}'
curl -s --unix-socket $S http://hrc/v1/events/head
curl -s --unix-socket $S 'http://hrc/v1/sessions?latestGeneration=true' | jq -c '[.[] | {hostSessionId, generation, status}]'
curl -s --unix-socket $S 'http://hrc/v1/events/page?afterSeq=0&limit=5' | jq -c '{ledgerIncarnationId, head, scannedThrough, n: (.rows|length)}'
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/page?afterSeq=0&limit=1001'      # 400
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/page?limit=5'                    # 400 afterSeq is required
curl -s -w ' http=%{http_code}' --unix-socket $S 'http://hrc/v1/events/page?afterSeq=0&limit=5&ledgerIncarnationId=bogus'   # 409
for p in /v1/registrations/gc /v1/bridges /v1/launches /v1/messages/wait /v1/in-flight-input /v1/runtimes/capture/release; do curl -s -o /dev/null -w "$p %{http_code}\n" --unix-socket $S http://hrc$p; done   # 404
grep -o 'route.not_served[^}]*}' /tmp/hv/<task>/serve.log; grep -o '"event":"server.listening"[^}]*}' /tmp/hv/<task>/serve.log
L=~/praesidium/var/run/hrc/hrc.sock    # live, read-only: remote-homed scope vs local control
curl -s -D- -o /dev/null --unix-socket $L 'http://hrc/v1/events/tail?limit=1&scopeRef=agent:mable:project:hrc-runtime:task:minisvc' | grep -iE '^HTTP|x-hrc-home-node'
curl -s -D- -o /dev/null --unix-socket $L 'http://hrc/v1/events/tail?limit=1&scopeRef=agent:clod:project:hrc-runtime:task:<task>' | grep -iE '^HTTP|x-hrc-home-node'
```

## Gotchas

- The host part of the URL is ignored; `http://hrc/…` is a convention, not a name that must resolve.
- **A retired route and an un-ported Bun route look the same on the wire.** Both are the bare plain-text 404;
  only serve.log's `route.not_served` line (native, no Bun socket) says a route was unserved rather than handled
  with a 404. Grade unserved routes by that line, and count lines per path (2026-11-02, T-12291).
- `/v1/federation/health` on the unix socket is a plain-text 404 too (peer routes live on the federation TCP
  listener; read federation health through `~/.bun/bin/hrc doctor`, feature 5). A routed `scopeRef` read carries the home's
  incarnation and head (2026-10-19: svc head 123941 vs max3's 3035766, T-11363); don't page it with the local one.
- **`turn.completed` is per turn, not per HRC run.** A turn the broker takes without an HRC dispatch (typed
  in the pane, a participant's own prompt) has no `runId` since e822f2a9 (T-11306), so "one per run" holds
  only when every turn came through `start`/`send`/`turn` (source-read; the five rows read on 2026-11-02 all carried a runId).
- **An `eventKind` page of exactly `limit` rows is not the total.** On 2026-11-02 `limit=5&eventKind=turn.completed`
  returned 5 distinct runIds while the scratch had 7 (`hrc_events.tsv`); read `truncated` before counting.
- `/v1/sessions` is a bare array; `.sessions` on it is a jq error.
- **Which daemon answered:** read serve.log's `server.listening {owner: "rusthrc", role: "native", bunSocket:
  null}` and the per-request `http.request … servedBy: "native"` (2026-11-02, T-12291). `.api.listenSocketPath ==
  .api.socketPath` is hard-coded on native (server.rs:1061) and proves nothing. Every non-stream request is
  logged now, with `caller` (from `x-praesidium-caller`, `unknown` for curl) beside `client` (the user-agent).
  The six unserved-route lines log `http.request … route: "unmatched"` too (2026-11-09).
- `headHrcSeq` stays the global head on a history page (124 on every page on 2026-11-02; 59 on T-10297, 46 on
  T-11363); bound your paging by `truncated`, not by `headHrcSeq`.

## Proven when

Paging backwards from the newest page with the returned incarnation walks contiguous, ascending pages to
`truncated: false` at `hrcSeq` 1; the tail refusals answer 400 (limit missing/0/501, bad generation, beforeHrcSeq
without incarnation) and 409 `cursor_invalid` with the documented strings; an `eventKind` filter returns only that
kind, one `turn.completed` per run the scratch drove when `truncated` is false; `/v1/events/page` answers from
`afterSeq` with its own 400/409 refusals; retired and never-ported routes are 404 with one `route.not_served` line
each; serve.log shows `owner rusthrc`; on live a remote-homed scope's tail carries `x-hrc-home-node` and the local
control does not.

Driven 2026-11-09 (T-12756 upkeep) on a native scratch (rusthrc, release-20261108171912823-43877, 846648d8),
scratch `t-12756` (107 events; pages 105-107, 102-104 and [1,2,3] `truncated: false`; eight `turn.completed`, one per
run; `latestGeneration` kept gen 3) and live read-only for the routed tail and `localOnly` (`x-hrc-home-node: svc`):
`~/praesidium/var/wrkq-artifacts/T-12756/{03-turns-monitor,04-http-api,evidence/t-12756}`.
