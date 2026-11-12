# Self-brokered seat launch contract

Status: approved design, 2026-11-12. Daedalus APPROVE of T-13434 rev 3
in reply to EN-52514. Implementation and acceptance remain pending.

This is the submitted revision, preserved verbatim below. Sections 3 through
11 are elevated by `hrc-runtime.self-brokered-seat-launch`; section 12 is
work-planning provenance. This contract is the declared exception to the
compiled-birth and external-participant clauses identified in the linked
active records. The existing admission stage order remains authoritative.

---

# Self-brokered launch — rev 3

Rev 3 answers Daedalus's rejections: F1 (EN-52508) in section 5, F2 (EN-52508) in section 9, F3 (EN-52513) in section 5.1. Other sections are unchanged from rev 1 except the gates.

Task T-13434, hrc-runtime. Author mable@hrc-runtime:foundrypty, 2026-11-12.
Authority: Lance, 2026-11-12, room T-13430: "Approve HRC starting Foundry's project seats? — Approve" and "Let HRC retire idle Foundry seats at 60 minutes? — Approve."
Companions: Foundry's side is `foundry/architecture/contracts/foundry-hrc-born-seats-v1.md` (draft r1). agent-spaces' side is section 3 of this spec.

Read from source; nothing in this spec has been run.

## 1. What this adds

One new way for HRC to start a seat. For an agent whose profile declares `launch = "self-brokered"`, HRC starts the profile's command on hrc-pty. That process is both the terminal program and a harness-broker/0.2 server. HRC records the participant registration itself and then runs the establishment it already runs for a joined participant.

The first user is `foundry@<project>:primary`. Today Foundry starts that process in its own tmux and registers it over HTTP, so HRC's row has no terminal and attach refuses.

What does not change: the establishment calls (`broker.installIdentity`, `broker.ensureInvocation`, `broker.attach`), descriptor validation, turn delivery to an active participant, the hrc-pty supervisor protocol, every HTTP route and its shape. No route is added.

## 2. Terms

- **Self-brokered seat**: a runtime started by this launch.
- **Launcher**: the profile's `launch_command`. HRC knows nothing about it beyond section 4.
- **External participant**: a runtime that registered itself over `POST /v1/participants/register`. Unchanged by this spec.
- **Supervisor**: the seat's `hrc-pty serve` process. **Child**: the process it runs on the terminal.

## 3. Profile contract (agent-spaces builds this section)

`agent-profile.toml`:

```
[placement]
launch = "self-brokered"
launch_command = ["foundry", "seat-launch"]
```

- `launch_command` is required with `self-brokered` and refused with any other value.
- The `resolveRuntimeDeclaration` response carries `placement.launch: "self-brokered"` and `placement.launchCommand: string[]`, the profile's array verbatim: no templating, no path expansion.
- A compile request for a self-brokered agent is refused, as it is for `participant-only`.
- Order of release: aspd on all three nodes, then HRC, then any profile edit. An aspd that predates this fails to parse the new value.

HRC reads those two fields where it reads `participant-only` today (`placement/federation/gate.rs:520`). The `participant-only` refusal does not apply to `self-brokered`.

## 4. Launcher contract

HRC runs, through the supervisor's `spawn` op:

```
<launchCommand...> --project-root <abs> --broker-socket <abs> --registration <abs> --descriptor-out <abs>
```

- cwd is the project root. Env is what the supervisor's login shell provides; HRC adds nothing. The launcher scrubs what it must.
- `--registration` names a file HRC wrote before the spawn, mode 0600: the body `POST /v1/participants/register` returns today for a created registration, unchanged. It carries the allocated identity (runtime, host session, generation, invocation, attempt, attach epoch) and the continuation HRC selected, if any.
- The launcher writes a complete `participant-broker-descriptor/v1` to `--descriptor-out` by rename, then listens on `--broker-socket` in participant-served mode.
- No identity or token is on argv.
- HRC waits 60 seconds from `spawn` for both the descriptor file and a listening socket. Missing either, or a child that exits first, is a failed start (section 9).
- A descriptor with no continuation after a registration that offered one is accepted: the seat chose to start fresh. Every other identity agreement check (`descriptor::agreement`) applies unchanged.

All four files live in the seat's ipc directory under the runtime root, with the supervisor socket and attach token. The directory name is short enough that both socket paths stay under 104 bytes, by the existing rule.

## 5. Birth

A birth has two steps, and they run at different points. **Allocation** records the registration and so fixes the seat's host session, generation and runtime identity. **Launch** starts the process and establishes with it. Allocation must come before anything binds an input to a session, because a host succession (section 6) archives the old session and moves the continuity to a new one.

### 5.1 Input doors (turn, enqueue, steer, invoke, mail delivery)

Admission's stages run in today's order: fence, drain lease, retired persona, participant resolution, ownership proof, capability authority, execution presentation, rotation, launch-carry observation. Allocation is a session-changing effect, so it happens in the **rotation** stage, where an HRC-owned session's rotation already happens, and nowhere earlier.

1. **Participant resolution only classifies.** For a scope whose declaration says `self-brokered` and which has no serving or establishing attempt, it returns a new state, `Delivery::Launch`, and writes nothing. An establishing attempt returns today's retryable `attachment_pending` refusal.
2. Every refusal that follows participant resolution runs against the existing session, unchanged: the participant `freshContext` refusal, ownership proof, capability and preempt authority, execution presentation. A request refused there has allocated nothing, moved no continuity and archived no session, as hrc-runtime.submission-admission-pipeline requires of a pre-effect refusal.
3. **Rotation stage.** For `Delivery::Launch`, under the existing per-continuity start gate: confirm the predecessor is gone (section 7), record the registration (the first one, or a host succession), and replace the plan's session with the one the registration returned. This is the stage's effect for a self-brokered scope, in the place where `materialize` rotates an ordinary session. A refusal here (a live predecessor, a store refusal) is the stage's own and leaves nothing allocated, because the registration is one transaction.
4. The plan is admitted carrying the successor's session and the registration and attempt ids.

So the admitted plan, the run row and the delivery all name the successor's host session and generation. Nothing is delivered against the archived session, and `participant_linkage_stale` cannot arise for the input that caused the birth.

Launch is route work, joined where the turn is delivered, as `Reconnect` is today:

5. Write the registration file. Start `hrc-pty serve` with no broker argv; send `spawn` with the section 4 argv.
6. Wait for the descriptor and the socket; freeze the descriptor as the attach route does; run establishment to ACTIVE.
7. Deliver the input through ordinary participant delivery. Its plan already matches the ACTIVE attempt.

If the route never runs after the plan is admitted (the daemon dies, or the request is dropped between admission and route), the attempt is left at identity-minted with no supervisor. Section 9's sweep abandons it at startup; while the daemon lives, the route's own failure path abandons it. An allocated attempt that has no launch in flight in this daemon process never blocks a later input: participant resolution treats an `hrc-launched` identity-minted attempt with no in-process launch as not establishing, and the rotation stage succeeds it.

A `freshContext: true` input to a self-brokered scope is refused, as for any participant today. A fresh conversation comes from `prae runtime archive --continuation drop`.

For an external participant every stage is unchanged, including the `participant.host_requested` knock.

### 5.2 Doors with no input (ensure, start, resume)

These reach `assert_reserved_address_allows_birth` and then `broker::birth` (`server/broker/broker.rs:280`). For a self-brokered scope they run allocation and launch back to back in that one call and deliver nothing. No plan exists before them, so the ordering problem of 5.1 does not arise.

`broker::birth` keeps its refusal for a scope held by an external participant.

HRC sends no priming turn in either case: priming text comes from a compile, and this agent has none.

## 6. Registration by HRC

HRC is the registrant. It calls the store's registration and attach functions directly, with the same validation as the routes; the route handlers are refactored so the logic is callable without an HTTP response type.

- `hostIncarnationId` is minted per birth.
- `participant_registrations.lifecycle_owner` is `hrc-launched` (today the only value is `externally-owned`). `join_direction` stays `participant-served`.
- **Every birth after the first is a host succession.** HRC supplies `expectedPredecessor` from the previous binding and its own evidence that the predecessor is dead (section 7). The store allocates a new host session, generation = previous + 1, and a new runtime, as `finish_participant_succession` does today. The refusal `participant_host_succession_unsupported` for a held reservation whose bindings are all retired does not apply to an `hrc-launched` registration: HRC executes that succession.
- Continuation offered: `continue` when the session's continuation is reusable, `fresh` after `prae runtime archive --continuation drop`.
- **Cutover from an external registration.** The first self-brokered birth for a scope that an external participant holds is a host succession over it, admitted only when HRC's transport probe finds the old socket dead. Otherwise the birth refuses `host_binding_conflict`, as today.

Guarantees other projects build on, each proved by a gate in section 10:
- G-gen: for one scope and lane, generation only increases, by one per birth.
- G-one: at most one child per scope and lane is alive; `spawn` is sent only after the predecessor's supervisor and child are confirmed gone.

## 7. Ownership and liveness

Today one predicate, `is_external_lifecycle_owner` (`server/broker/controller/mod.rs:733`), answers two different questions at about 26 sites. This spec splits it:

- **`external_lifecycle(rt)`**: someone else starts and stops the process. True for an external participant, false for a self-brokered seat.
- **`participant_served(rt)`**: the broker is the participant's own, so HRC reconnects by establishment, not by the ordinary broker reattach. True for both.

A self-brokered runtime records `lifecycleOwner: "hrc"` and `participant.lifecycleOwner: "hrc-launched"`.

Sites that ask who owns the process use `external_lifecycle`, so a self-brokered seat is treated as any hrc-pty seat there: crash marking, liveness reconcile, user-exit reap, teardown, terminate (ordinary terminate, not `evict_external`), seat retirement, aging and prune guards, restart garbage collection, run sweep and reconcile, start-refused settle.

Sites that ask how to talk to the broker use `participant_served`: the `invocation.exited` route to `participant::mark_terminal`, stale-on-attach-failure, startup reattach (`establishment::resume`, never `broker::hello` with a release identity), and the self-restart refusal (`turns/restart.rs:271`).

The first build task produces the classified site list as its artifact, with no behaviour change, before any other task starts. A site whose HRC-owned path reads the aspd preparation record must be named there, because a self-brokered runtime has none.

Liveness for a self-brokered seat (`lease.rs:401-414` and its callers):
- supervisor missing: dead, as today;
- supervisor `broker.state` is `none` by design and is not a death;
- child exited: dead, reason `broker_hrcpty_child_exited`.
`brokerPid` records the child's pid, since the child is the broker.

Terminate and retirement end the supervisor's lease, mark the attempt terminal and retire the binding, keeping the session's continuation unless the caller drops it. The reservation stays held.

## 8. What HRC records

The runtime row matches an HRC-launched hrc-pty seat (`hrc-store/src/broker.rs:193-208`): transport `hrcpty`; substrate `leased-hrcpty` with supervisor socket and pid; presentation `hrcpty` with the attach command and `operatorAttachable`. `GET /v1/attach`, seat streams, the attach row member and `hrc-pty attach --seat` then work with no change of their own. The dead `hrcpty` branch in `establishment.rs:242-247` is deleted: a self-brokered seat owns its terminal's stdio and takes no terminal-surface lease.

## 9. Failed and interrupted starts

**Failed start, daemon running.** A launcher that exits, or produces no descriptor or socket in 60 seconds, or a descriptor that fails validation, or an establishment that fails: HRC ends the supervisor's lease, abandons the attempt, retires its binding, and answers the input with retryable `runtime_unavailable` naming the reason. The next input allocates again as a succession. HRC does not restart a launcher on its own.

**Daemon lost during a launch.** The attempt row exists before `spawn` (allocation precedes launch), and the supervisor's socket and pid file are at a path derived from the attempt's runtime id, so a restarted daemon can find every supervisor it ever spawned without a new column. At startup, for each `hrc-launched` attempt that is not terminal:

- descriptor frozen and hosting intent recorded: existing establishment recovery (`pending_participant_work`) finishes or reconnects it, as for an external participant;
- anything earlier (identity minted, or descriptor frozen with no hosting intent): HRC does not resume it. It ends the supervisor's lease if one answers, which kills the child, then abandons the attempt and retires the binding, reason `launch_interrupted`.

After that the scope has no live predecessor, so the next input births normally. The input that was in flight when the daemon died was never answered; its sender retries, as for any request a daemon restart cuts off. Resuming a half-finished launch is not supported.

## 10. Gates

One e2e driver on an isolated daemon, with a stub launcher that serves the participant-served broker protocol, in the pattern of `crates/hrc-native/e2e/participant_live.py`. Each gate names a product claim.

| # | Claim | Discriminator |
| --- | --- | --- |
| G1 | An input to a self-brokered scope with no runtime births it on hrc-pty; the turn completes; `GET /v1/attach` returns an hrcpty descriptor and a pty stream opens. | A `participant-only` scope in the same run still refuses and knocks. |
| G2 | After terminate with continuation kept, the next input births generation + 1, that input's turn completes, and its run row carries the new host session and generation; the registration offers a continuation, and after a drop it offers none. | Generation read from two successive registration files; the run row's session differs from the archived one. |
| G3 | Two inputs sent together to a retired scope produce one `spawn`; a birth never spawns while the predecessor's child is alive. | Supervisor and child pids from the previous birth are absent before the new `spawn` is logged. |
| G4 | A daemon restart with the seat live reconnects it; the next turn is delivered; no second child exists. | Same child pid before and after. |
| G5 | Killing the child marks the seat dead with `broker_hrcpty_child_exited`; the next input births a new one. | A seat whose child is alive in the same pass is judged live. |
| G8 | An input refused after participant resolution (a `freshContext: true` enqueue to a retired self-brokered scope) changes nothing: same host session, same generation, no attempt row added; a plain enqueue sent next births and completes. | Registration and session rows counted before and after the refused request. |
| G6 | A launcher that exits non-zero yields retryable `runtime_unavailable`, no runtime left `ready`, no supervisor left running. | — |
| G7 | The daemon is killed after `spawn` and before the launcher writes its descriptor. After restart the child and supervisor are gone, the attempt is abandoned `launch_interrupted`, and the next input births and completes a turn. | A seat that was ACTIVE across the same restart keeps its child pid (G4). |

Foundry's contract carries the live acceptance with the real model (its A1 to A6).

## 11. Explicitly unsupported

- tmux as the terminal for this launch.
- `prae seat restart` (self-restart) for a self-brokered seat: refused as for a participant today. A new process comes from retirement or `prae runtime archive`.
- A priming turn, a launch-carried prompt or a response-format preflight for a self-brokered birth.
- Restarting a failed launcher automatically, resuming a launch a daemon restart interrupted, or distinguishing how a launcher stalled.
- A launcher that listens on the socket and never answers `installIdentity`: establishment's existing timeout and retry budget apply; no separate detection.
- Two self-brokered seats for one scope on different lanes sharing a launcher's private state: Foundry runs lane `main` only.

## 12. Work, after approval

Tasks of two hours or less, each to one agent. Tasks marked (held) edit files the seat-streams campaign (T-13420) holds and start after it closes.

1. Split the ownership predicate; classified site list; no behaviour change.
2. Registration callable without HTTP; `hrc-launched` owner; HRC-run succession.
3. Launch: allocation in admission with `Delivery::Launch`, supervisor without broker, `spawn`, the four files, the 60-second wait, the no-input doors, the runtime row (held: `server/broker/hrcpty.rs`).
4. Liveness, terminate, startup reconnect and the interrupted-launch sweep for the new owner (held: `lease.rs` liveness is shared with streams work in `hrcpty.rs`).
5. The e2e driver and gates G1 to G8.
6. Pi's terminal query answers in `crates/hrc-pty` (held).
7. agent-spaces: section 3, then an aspd release (owner mable@agent-spaces:primary).

Already dispatched and independent: T-13432, idle retirement for `foundry@*:primary` at 60 minutes.
