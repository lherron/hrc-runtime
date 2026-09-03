/**
 * T-07575 — one definition of "when was this session last active", shared by
 * every consumer that needs it.
 *
 * Two rules came out of daedalus's rejection of the first design, and both are
 * load-bearing.
 *
 * **There is one recency authority, and it is `session_index.last_activity_at`.**
 * The active invariant `hrc-runtime.mobile-session-index` defines session
 * recency as the greatest observed contributing activity timestamp, and that
 * column is what carries it: triggers advance it on every insert into
 * `hrc_events` *and* `events` (see `session_index_hrc_event_insert` /
 * `session_index_event_insert` in the schema migrations). A sensor built on
 * `sessions.updated_at` misses all of that. It is not a theoretical gap — on
 * the host T-07575 was filed against, 5,380 of 8,319 rows have an index clock
 * strictly newer than `sessions.updated_at`.
 *
 * **Nothing in this expression may be written by the archive sweep.** The first
 * design used `sessions.updated_at`, which `SessionRepository.updateStatus`
 * rewrites to `now` on every archive. That makes the predicate self-defeating:
 * archiving a four-month-old row would have marked it as having been active
 * this second, so the one-shot would have made ~3,700 cold rows hot and left
 * the bounded projection larger than it started. Every input below is either
 * immutable (`sessions.created_at`) or advanced only by genuine activity
 * (`session_index.last_activity_at`, `runtimes.last_activity_at`).
 *
 * Both expressions are written against a `sessions` row aliased `s`.
 */

/**
 * Greatest contributing activity timestamp for a session, as an ISO-8601
 * string. `''` is the neutral element — it sorts before any real timestamp —
 * and `s.created_at` is NOT NULL, so the result is always a real value.
 *
 * `created_at` is the floor rather than a fallback for one specific population:
 * superseded generations have no `session_index` row at all (the index is keyed
 * by scope and lane and holds only the current head), so they would otherwise
 * have no clock. When a generation was created is a sound, immutable floor for
 * one that was rotated away.
 */
export const SESSION_RECENCY_SQL = `MAX(
      COALESCE(
        (SELECT si.last_activity_at FROM session_index si
          WHERE si.host_session_id = s.host_session_id),
        ''
      ),
      COALESCE(
        (SELECT MAX(COALESCE(r.last_activity_at, r.created_at)) FROM runtimes r
          WHERE r.host_session_id = s.host_session_id),
        ''
      ),
      s.created_at
    )`

/**
 * Whether the session holds any runtime that is not terminal.
 *
 * This is a **deny-list of terminal statuses, not an allow-list of live ones**,
 * and that direction is the whole point. An earlier revision asked
 * `status IN ('ready','busy')`, which reads as "is it live" but actually
 * answers "is it one of the two states I happened to think of". HRC produces
 * `starting`, `stopping`, `awaiting_input`, `stopped`, `failed`, `disposed` and
 * `adopted` as well (`runtime-status-contract.ts`), and the running-turn
 * authority counts `busy`, `awaiting_input`, `starting` and `stopping` all as
 * running (`hrc-mail-kicker`). Under the allow-list, a continuation-
 * bearing turn parked on an operator prompt for a week had no activity, was not
 * `ready` or `busy`, and so became an archive candidate — the sweep would have
 * filed a live turn as dormant. Idle cleanup already records exactly why that
 * case is decisive: *a parked ask has no activity but is not idle*
 * (`sweep-reconcile.ts`).
 *
 * Stated as a deny-list, a runtime status nobody has invented yet blocks
 * archival by default instead of permitting it. The terminal set is the same
 * one `isRuntimeUnavailableStatus` uses, so there is a single answer in the
 * codebase to "is this runtime gone".
 *
 * An active run is honoured independently of status: a row carrying
 * `active_run_id` is mid-turn whatever its status column says.
 *
 * Both consumers read this one expression, in opposite directions and for the
 * same reason — liveness beats age. The projection shows such a session however
 * old its timestamps are; the sweep refuses to archive it.
 */
export const SESSION_HAS_RUNNING_RUNTIME_SQL = `EXISTS (
      SELECT 1 FROM runtimes r2
        WHERE r2.host_session_id = s.host_session_id
          AND (
            r2.active_run_id IS NOT NULL
            OR r2.status NOT IN ('terminated', 'dead', 'stale', 'crashed', 'detached')
          )
    )`
