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
| `hostSessionId`, `generation`, `scopeRef`, `laneRef`, `runtimeId`, `runId`, `category`, `eventKind`, `sourceRef` | no | The existing exact event filters, unchanged. |

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

## SDK

`HrcClient.tailEvents(options: HrcEventTailOptions)` — `beforeHrcSeq` and
`ledgerIncarnationId` are optional fields alongside `limit` and the filters, and
a `cursor_invalid` response surfaces as an `HrcDomainError` with
`code = 'cursor_invalid'` and `status = 409`.

Callers that omit both new fields are unchanged in request bytes and response
shape.
