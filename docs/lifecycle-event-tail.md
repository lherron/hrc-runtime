# `GET /v1/events/tail` — bounded lifecycle-event pages

Wire contract for HRC's bounded lifecycle-event tail: the newest page, and the
exclusive-before reverse page that walks history backwards from an already-loaded
cursor (T-07719). Governed by the
`hrc-runtime.bounded-lifecycle-event-observation` architecture invariant.

This route is the **history** surface. `GET /v1/events/bounded-stream` is the
forward replay/live stream and is not a paging mechanism; its `afterSeq` cursor
advances a consumer's forward position, and nothing here touches it.

## Request

| Parameter | Required | Meaning |
| --- | --- | --- |
| `limit` | yes | Page size, `1..500`. |
| `beforeHrcSeq` | no | **Exclusive** upper bound. Selects only matching rows with `hrc_seq < beforeHrcSeq`. Omit for the newest page. |
| `ledgerIncarnationId` | with `beforeHrcSeq` | The incarnation the cursor was minted against, taken from the previous page's response. |
| `hostSessionId`, `generation`, `scopeRef`, `laneRef`, `runtimeId`, `runId`, `sourceRef` | no | The existing exact event filters, unchanged. |
| `category`, `eventKind` | no | Comma lists of exact values (T-12422). Each is a set; when both are given a row passes if it matches either. A list with no values is a 400. The same rule holds on `GET /v1/events` (history and `follow=true`), `bounded-stream` and `latest-by-session`. |

## Response

```json
{ "events": [...], "ledgerIncarnationId": "…", "headHrcSeq": 1234, "truncated": true }
```

- `events` is **chronological** (ascending `hrcSeq`) even though the page is
  selected newest-first.
- `headHrcSeq` is the ledger's global head at read time, not the page's own
  boundary. It does not move because a history cursor was supplied.
- `truncated` means still-older **matching** rows exist relative to the requested
  `beforeHrcSeq` boundary.
- `ledgerIncarnationId`, `headHrcSeq`, and the page all come from one read
  transaction.

## Paging backwards

1. Fetch the newest page with `limit` and your filters, no cursor. Keep its
   `ledgerIncarnationId`.
2. For each older page, pass `beforeHrcSeq=<oldest hrcSeq you hold>` plus that
   `ledgerIncarnationId`.
3. Stop when a page returns `truncated: false` (an empty `events` array at the
   start of history is the normal terminal page).

The filters are applied in SQL before the descending `limit + 1` read, so
unrelated sessions and generations never consume page capacity, and the read
stays index-backed on `(host_session_id, generation, hrc_seq)`.

## Errors

| Condition | Status | Code |
| --- | --- | --- |
| `limit` missing, non-integer, `< 1`, or `> 500` | 400 | `malformed_request` |
| `beforeHrcSeq` non-integer, `< 1`, or beyond the safe-integer range | 400 | `malformed_request` |
| `beforeHrcSeq` without `ledgerIncarnationId` | 400 | `malformed_request` |
| `ledgerIncarnationId` does not match the current ledger | 409 | `cursor_invalid` |

A `cursor_invalid` response carries `expectedLedgerIncarnationId` /
`currentLedgerIncarnationId` in its detail and **no event payload**: the ledger
was replaced, so the cursor addresses a history that no longer exists. Restart
from the newest page.

## Federation routing

A request whose `scopeRef` filter names a scope homed on another node is
forwarded to that home (T-10418); the response carries `x-hrc-home-node`, and
its `ledgerIncarnationId` and cursors belong to the home's ledger. A request
without `scopeRef` (for example `hostSessionId` only) is always served locally.
Scope routing adds three retryable refusals, all `503`:

| Condition | Code |
| --- | --- |
| The registry cannot say where the scope is homed | `session_home_unknown` |
| This node retired the scope and no new home is bound | `session_home_pending` |
| The home peer is undeclared or unreachable | `session_home_unreachable` |

## SDK

`HrcClient.tailEvents(options: HrcEventTailOptions)` — `beforeHrcSeq` and
`ledgerIncarnationId` are optional fields alongside `limit` and the filters, and
a `cursor_invalid` response surfaces as an `HrcDomainError` with
`code = 'cursor_invalid'` and `status = 409`.

Callers that omit both new fields are unchanged in request bytes and response
shape.

## Participant host demand

A host follows `GET /v1/events/bounded-stream` with
`eventKind=participant.host_requested`, retaining `afterSeq` and
`ledgerIncarnationId` for reconnects. These category `participant` rows have
sentinel host session `hrc-participant`, generation 0, and no runtime or run
attribution, following the store’s convention for an event that belongs to no
session. The knock does not count as session activity. An existing refused-turn
`submission.admission` audit can independently advance the retained session’s
activity; parking does not change that audit. The payload contains `scopeRef`,
`laneRef`, `reservationId`,
`door` (`turn`, `turn-lazy`, `ensure`, `resume`) and `requestedAt`.

The event reports an addressed refusal at a held reservation whose latest
registration attempt cannot serve work (missing, absorbing, or non-ACTIVE
with establishment exhausted). A retained BOUND binding does not suppress it.
ACTIVE and still-establishing hosts produce no knock. HRC emits at most one
per reservation per 30 seconds in one daemon lifetime; restart can admit an
extra. Append failures are logged and preserve the refusal. HRC never calls
or starts the host; observing a knock promises neither hosting nor delivery.

`POST /v1/terminate` accepts optional `disposition: "parked"` only for an
external lifecycle owner. Other owners and other disposition values return
400 before termination. The reservation records nullable `disposition` and
`disposition_at`; target reads expose `disposition` and `dispositionAt`, and
participant refusal messages identify a parked host. Repeating eviction
preserves the recorded time. Admitting a new registration attempt clears both
fields; retrying an existing registration does not. Parking changes no
reservation, binding, continuation, refusal or retry policy. Migration
`0133_participant_parked_disposition` adds these nullable columns to the
exported reservation table.
