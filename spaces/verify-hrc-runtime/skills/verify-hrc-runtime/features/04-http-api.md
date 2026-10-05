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
```

## Gotchas

- The host part of the URL is ignored; `http://hrc/…` is a convention, not a name that must resolve.
- `/v1/federation/health` on the unix socket is `404 Not Found` (plain text, not JSON): peer routes live
  on the federation TCP listener. Read federation health through `hrc doctor` (feature 5).
- `headHrcSeq` stays the global head on a history page (59 on every page of the T-10297 drive, 58 on
  T-10350's); bound
  your paging by `truncated`, not by `headHrcSeq`.

## Proven when

Paging backwards from the newest page with the returned incarnation walks contiguous, ascending pages to
`truncated: false` at `hrcSeq` 1; the three refusals answer 400, 400 and 409 with the documented codes; an
`eventKind` filter returns only that kind, one `turn.completed` per run the scratch drove.

Driven 2026-10-05 (T-10350 upkeep) on installed 5bdb6c4e, scratch `t-10350` (58 events in three contiguous
pages of 25, four `turn.completed` for four runs): `var/wrkq-artifacts/T-10350/04-http-api/drive.txt`.
