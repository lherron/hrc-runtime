# HRC Turn Redesign Review

> **Status: REVIEW DRAFT — NOT IMPLEMENTATION AUTHORIZATION**
>
> Implementation of T-08407 is paused at Lance's direction. This document explains how a recoverable New Session UI expanded into a material HRC/ACP lifecycle redesign, separates the independently useful changes, and presents options for review. No source change, installation, migration, or service restart is authorized by this document.

## Executive summary

The original product problem is straightforward:

- A failed session start leaves HRCMac's New Session dialog stuck.
- Restarting HRCMac restores the stale failed attempt.
- The form is locked, so after Astra fails the user cannot select Clod and submit a genuinely new attempt.
- The visible error omits the actual ACP/HRC failure and gives no safe recovery guidance.

That problem does **not inherently require an HRC turn redesign**. It requires a client-side attempt state machine, correct interpretation of ACP errors, restart reconciliation, and a clear distinction between retrying the same request and starting over with a new request.

The approved T-08407 revision 4 specification goes substantially further. It introduces a durable HRC lifecycle in which session creation can reserve a session and persist launch intent without starting a runtime. The first real user input then materializes the runtime. Supporting that behavior affects HRC persistence, claims, lineage, broker dispatch, federation, ACP contracts, and both clients.

Before proceeding, we should decide which product behavior is actually intended:

1. Repair only the client recovery experience.
2. Repair the client and route ACP creation through HRC's existing broker-compatible start path.
3. Adopt deferred first-turn materialization as a new platform lifecycle.

The recommended next step is to investigate and prove option 2 before committing to option 3. Option 3 should proceed only if deferring runtime creation until first input is itself a product requirement, or if the existing broker path cannot satisfy session creation safely.

## Why creation fails today

The observed flow is:

1. The HRCMac plugin sends `POST /v1/mobile/sessions` to ACP.
2. ACP constructs an HRC launch request with an internally inconsistent combination: an interactive session paired with a preferred headless mode.
3. HRC's broker selection excludes the normal OpenAI/Codex broker route when `interactive` is true.
4. The request falls through to the retired legacy executable path.
5. HRC returns a `runtime_unavailable` error explaining that the headless CLI start path is retired and provisioning should use the broker path.
6. ACP returns that error as a nested error object in an HTTP 503 response.
7. The plugin looks for the code at the wrong level, treats the definitive failure as an uncertain outcome, persists the submitted attempt, and keeps the form locked.
8. On a fresh HRCMac launch, plugin storage restores that submitted attempt before the user does anything, so the dialog appears already failed and disabled.

This is three related but separable problems:

- **Client recovery defect:** stale submitted state, locked controls, and incorrect nested-error parsing.
- **ACP/HRC launch mismatch:** ACP asks HRC for a combination that bypasses the supported broker route.
- **Proposed platform redesign:** reserve a session now but defer runtime creation until its first real input.

The first two explain the current failure. The third is a possible architecture choice, not a necessary conclusion from the UI defect alone.

## Required product behavior regardless of architecture

These behaviors should be preserved under any selected option.

### After a definitive failure

- Return the form to an editable state.
- Preserve the entered values for convenience.
- Allow the user to change agent, project, scope, or viewer selection.
- Allow Astra to fail, then let the user select Clod and submit a new attempt.
- Generate a new idempotency key/request identity for the new attempt.
- Show the stable error reason, whether retrying is appropriate, and whether HRC claims a session was created.

### After an uncertain outcome

An uncertain outcome means the client cannot prove whether the server accepted the request. The UI must preserve the exact request fence and offer two distinct actions:

- **Retry same request:** use the same idempotency key so the server can replay the original result without creating a duplicate.
- **Start over:** retire the local attempt only after a warning that the original request may have succeeded and could still appear later.

The form should not silently unlock and mint a new request when success remains possible.

### After HRCMac restarts

- Do not immediately render a restored submitted attempt as a fresh failure.
- Enter a visible `Checking previous attempt…` state.
- Reconcile the persisted request with ACP.
- Settle into success, definitive failure/editable form, claimed-but-not-started recovery, or uncertain/manual choice.
- Never leave all controls disabled solely because stale local state says the request was submitted.

### Error presentation

The UI should show:

- a short user-facing summary;
- a stable machine error code and reason when available;
- whether the failure is retryable;
- whether the server reports `not claimed`, `claimed but not started`, `started`, or `unknown`;
- any known session identifier;
- an expandable diagnostic section containing the request ID and sanitized underlying message.

## Decision under review

The central question is:

> Does New Session need to create a durable session reservation while deliberately postponing runtime creation until the first real user input?

If the answer is no, the larger HRC lifecycle and federation work may be unnecessary. If the answer is yes, the HRC and ACP changes in the approved revision 4 design are justified because the deferred state must be durable, idempotent, crash-safe, and consistent across nodes.

## Options

### Option A — Client recovery only

Change HRCMac's plugin state machine and error parsing, but do not change provisioning.

What it accomplishes:

- The dialog no longer remains stuck after a failure or restart.
- The user can select Clod after Astra fails and submit a fresh attempt.
- Error messages expose the real server failure and safe actions.

What it does not accomplish:

- Astra creation continues to fail wherever ACP still selects the retired HRC path.
- It treats the symptom and recovery experience but does not repair provisioning.

This is the smallest coherent client fix, but it is incomplete as an end-to-end product repair.

### Option B — Client recovery plus the existing broker path

Fix the client behavior and change ACP's launch request so it is compatible with HRC's existing broker runtime route.

The current HRC broker implementation appears capable of starting a headless broker runtime with an empty initial prompt and returning once the runtime is available. That means New Session may be able to create a live runtime without inventing an empty or synthetic user turn and without adding a new deferred-materialization lifecycle.

Likely scope:

- HRCMac plugin state machine, persistence, reconciliation, and error UI.
- ACP request construction and flat error normalization.
- Possibly native iOS parity, depending on release scope.
- Focused HRC changes only if live validation exposes a defect in the existing broker start contract.

Advantages:

- Repairs the actual route mismatch.
- Avoids a new claim state, persisted launch-intent transaction, lineage audit, nullable runtime response, and federation protocol change.
- Preserves the intuitive meaning that a successfully created session has a running runtime.

Questions that must be proven with the real stack:

- Can Astra be created through the existing broker path with no initial prompt?
- Does the returned session have valid continuation and runtime identity?
- Does creation avoid recording a synthetic user turn?
- Are idempotent replays safe before and after runtime creation?
- Do Clod and other supported harnesses keep their current behavior?
- Does a runtime started but never used impose an unacceptable resource cost?

This is the recommended first investigation because it may satisfy the product requirement with much less platform change.

### Option C — Deferred first-turn materialization

Adopt T-08407 revision 4 as a platform lifecycle: session creation reserves the identity and launch intent, while the first real input starts the runtime.

What this adds:

- A durable `awaiting_first_turn` state.
- Atomic persistence of the session claim, continuity, and the intent required to start the runtime later.
- First-input dispatch that creates the broker runtime and then submits the real input.
- New idempotency and lineage rules covering recycled sessions and archived intermediate generations.
- Federation changes so remote exact and roster starts propagate the materialization mode and nullable runtime result.
- ACP and client changes to represent claimed-but-not-started sessions explicitly.

Advantages:

- No idle runtime is created merely by opening/confirming New Session.
- The first runtime turn always corresponds to real user input.
- A crash or restart between claim and first input can be recovered from durable state.

Costs and risks:

- Changes the meaning of successful session creation: a session can exist without a runtime.
- Adds a new persistent HRC state and transaction boundary.
- Expands claim ownership and replay logic across full generation lineage.
- Changes federation protocol and mixed-version behavior.
- Requires downstream code to tolerate `runtimeId: null`.
- Introduces deployment-order and migration concerns.
- Enlarges the validation matrix across local, federated, mint, recycle, retry, crash, and restart paths.

This option is warranted only if deferred runtime creation is desired product behavior, not merely as a way around the current routing defect.

## What option C changes in plain terms

### HRC changes

HRC would stop treating every successful session claim as an instruction to start a process immediately.

For callers that explicitly request first-turn materialization, HRC would:

1. Choose or recycle the session identity.
2. Save the exact runtime launch instructions it will need later.
3. Save claim ownership and continuation state in the same durable transaction.
4. Return a successful session in `awaiting_first_turn` with no runtime ID.
5. Treat that session as occupied so another caller cannot take it.
6. On the first real user input, atomically establish ownership, start the broker runtime, and send that input as the first turn.
7. Recover the same operation safely after crashes or retries.

HRC would also audit ownership through the entire prior-session lineage when replaying or recycling a request. A later, independently claimed generation must never be mistaken for the result of an older idempotency key. Archived intermediate generations remain part of that audit.

Existing HRC callers that omit the new materialization preference would retain today's claim-and-start behavior.

### ACP changes

ACP would remain the single mobile creation door at `POST /v1/mobile/sessions`, but it would explicitly ask HRC for first-turn materialization.

ACP would also normalize failures into one flat contract containing:

- a request ID;
- stable error code and reason;
- retryability;
- `attemptState`: `not_claimed`, `claimed_not_started`, `started`, or `unknown`;
- known claimed session identifiers when available.

That contract lets clients make safe choices. A client may automatically discard a failed attempt only when ACP proves it was not claimed. If ACP says the session may have been claimed or started, the client must preserve the original request identity or explicitly warn before starting over.

### Federation changes

Remote exact-start and roster-start requests would carry the materialization preference. Responses must tolerate a claimed session with no runtime ID. Mixed-version peers would fail closed rather than silently dropping the new field and accidentally starting a runtime under different semantics.

## Safety invariants for option C

If deferred materialization is selected, these are mandatory:

- Session, continuity, launch intent, and claim ownership are committed atomically.
- `awaiting_first_turn` counts as occupied.
- A first input is delivered at most once to one materialized runtime.
- The original idempotency key replays the same claimed result.
- A different idempotency key cannot inherit or alias an older claim.
- Replay ownership is checked across the full prior-session chain, including archived links.
- The client retires a fence automatically only when the server proves `not_claimed`.
- Known claimed identities are retained in errors and reconciliation responses.
- Callers that do not opt in retain current claim-and-start semantics.
- A peer that cannot honor the materialization field rejects the request rather than guessing.

## User-visible state model

The New Session form should use explicit states rather than a single sticky submitted flag:

- `draft`: fields editable; Create enabled when valid.
- `submitting`: fields temporarily locked; cancellation semantics explicit.
- `checkingPreviousAttempt`: restored request is being reconciled.
- `definitiveFailure`: fields editable; user can modify selections and create a new attempt.
- `uncertain`: exact request fence retained; Retry Same Request and Start Over offered.
- `claimedNotStarted`: known session retained; continue/reconcile action offered.
- `started`: navigate to the created session.

Example: Astra fails definitively. The form returns to `definitiveFailure`; the agent buttons become active; the user selects Clod; Create submits a new request with a new idempotency key.

## Recommended review path

1. Keep implementation paused.
2. Confirm whether deferred runtime creation is a product requirement.
3. In an isolated diagnostic pass, test option B against the real ACP-to-HRC broker path without changing production services.
4. If option B works and idle runtime cost is acceptable, narrow T-08407 to client recovery, ACP routing, and error-contract work.
5. If option B cannot satisfy the lifecycle or deferred creation is explicitly desired, retain option C and review its migration, federation, and recovery semantics before reauthorizing implementation.
6. Amend the existing architecture records if the selected direction differs materially from revision 4.

## Review questions

1. On Create, should the system start a live runtime immediately, or only reserve the session?
2. Is an idle broker runtime acceptable until the first message arrives?
3. Must the first real message be what materializes the runtime?
4. How should `awaiting_first_turn` appear in session lists and inspectors?
5. How long may a claimed-but-not-started session remain before cleanup?
6. Must native iOS receive the same recovery state machine in the first delivery?
7. What warning copy is acceptable when Start Over could leave an earlier uncertain session visible later?
8. What rollout ordering is acceptable if HRC, ACP, and clients must change together?

## Validation plan

### Common client recovery gates

- Reproduce a definitive Astra failure and verify every selector becomes usable.
- Select Clod and successfully submit a fresh attempt without reopening the dialog.
- Restart HRCMac with persisted `submitting`, `uncertain`, and failed records and verify reconciliation.
- Verify nested and flat ACP errors map to the correct state.
- Verify Retry Same Request preserves the idempotency key.
- Verify Start Over generates a new key and warns when success was possible.
- Verify the installed HRCMac UI, not only unit-level state transitions.

### Additional option B gates

- Create Astra through the real ACP/HRC broker route with no initial prompt.
- Confirm no synthetic user turn appears in the event stream.
- Confirm returned runtime and continuation identities are usable for the first real input.
- Repeat the same idempotency key before and after completion and prove no duplicate session/runtime.
- Exercise Clod and existing callers for regression coverage.

### Additional option C gates

- Crash at each boundary between claim, persistence, response, first input, runtime start, and input dispatch.
- Reconcile every crash state after HRC, ACP, and client restarts.
- Exercise mint and recycle paths, including archived intermediate lineage.
- Prove an independently claimed successor is never returned for an older request key.
- Test local and federated paths with compatible and incompatible peer versions.
- Prove non-opting callers retain claim-and-start behavior.
- Validate cleanup policy for abandoned `awaiting_first_turn` sessions.

## Current implementation status

- Daedalus approved T-08407 revision 4 as architecturally internally consistent. That ruling is not a substitute for product approval of the expanded scope.
- Architecture-law records for that design have already been committed in the HRC and ACP repositories.
- Cody was dispatched before this scope review and has now been told to stand down.
- Cody's partial implementation comprised 12 uncommitted HRC files across contracts, claim handling, federation, turn dispatch, persistence, and tests. At Lance's direction, those exact working-tree changes were rolled back on 2026-09-12. The HRC repository has no remaining tracked implementation diff from that work.
- This review document does not authorize completing, committing, installing, migrating, or deploying those changes.

## Proposed decision record

Record one explicit choice before implementation resumes:

- **A — Recovery only**
- **B — Recovery plus existing broker provisioning**
- **C — Deferred first-turn lifecycle per revised and re-approved specification**

For choice C, also record the intended product statement: **“Creating a session reserves it; the first real input starts its runtime.”** Without agreement on that statement, the platform redesign should not proceed.
