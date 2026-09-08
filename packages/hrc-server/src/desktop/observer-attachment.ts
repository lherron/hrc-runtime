/**
 * Ordinary broker attachment for an EXTERNALLY owned desktop thread (T-08294 §3).
 *
 * Two ideas that pull in opposite directions have to hold at once here.
 *
 * The first is "ordinary": the observer is a normal durable broker invocation.
 * It goes through the same `HarnessBrokerController.start` the headless route
 * uses, over the same unix NDJSON substrate, with the same ledger and capture
 * pipeline, so replay, snapshots, seat probing and admission all work without a
 * parallel implementation. Nothing about desktop earns a private event protocol.
 *
 * The second is "externally owned": HRC owns the OBSERVER and nothing else. It
 * may stop, restart and reattach its own observer freely; it may never signal
 * desktop, resume desktop's thread elsewhere, scrub its queue, or replace it
 * with a cold CLI birth. The carrier of that distinction is one field —
 * `runtimeStateJson.lifecycleOwner: 'external'` — because that is the field the
 * existing guard `isExternalLifecycleOwner` already reads in sweep-reconcile,
 * sweep-helpers, sweep-handlers, startup-reconcile, runtime-io-handlers and
 * turn-dispatch-handlers. Writing it is what buys every one of those protections;
 * inventing a second marker would buy none of them.
 *
 * The plan/profile below is built through the DIRECT-plan seam
 * (`agent-spaces-adapter/direct-agent-harness.ts` is the existing example), not
 * the ASPC compiler: there is no agent bundle to compile for a conversation
 * desktop already owns, and no process for HRC to exec.
 */

import { createHash, randomUUID } from 'node:crypto'

import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { DesktopThreadRegistration } from 'hrc-store-sqlite'
import type { HarnessInvocationSpec, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import {
  type BrokerExecutionProfile,
  type CompiledRuntimePlan,
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  type RuntimeIdentityAllocation,
  hashNeutralStartRequest,
  neutralSpecHash,
  neutralStartRequestHash,
  project,
  validateBrokerExecutionProfile,
} from 'spaces-runtime-contracts'

import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

import { resolveLifecyclePolicyOverlay } from '../broker/lifecycle-overlay.js'
import { writeServerLog } from '../server-log.js'
import { timestamp } from '../server-util.js'

/** The broker driver ASP registers for desktop observation (T-08293). */
export const CODEX_DESKTOP_BROKER_DRIVER = 'codex-desktop'

function hashValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex')
}

/**
 * The private driver configuration, agreed with the observation leg.
 *
 * It rides `spec.driver`, which the public contract types as
 * `CodexAppServerDriverSpec | UnknownDriverSpec` where `UnknownDriverSpec` is
 * `{ kind: string; [key: string]: unknown }`. That is the existing extension
 * point the design mandates; no wire schema changes to carry it.
 */
export type CodexDesktopDriverSpec = {
  readonly kind: typeof CODEX_DESKTOP_BROKER_DRIVER
  /** Resolved desktop-bundled executable. Compatibility metadata, not identity. */
  readonly bundleExecutable: string
  readonly codexHome: string
  readonly sqliteHome: string
  readonly threadId: string
  readonly rolloutPath: string
  readonly adoptionWatermark?: { readonly byteOffset: number } | undefined
}

export type DesktopObserverPlan = {
  readonly plan: CompiledRuntimePlan
  readonly profile: BrokerExecutionProfile
  readonly startRequest: InvocationStartRequest
  readonly specHash: string
  readonly startRequestHash: string
  readonly identity: RuntimeIdentityAllocation
}

/**
 * Build the observer invocation for one registered desktop conversation.
 *
 * Deliberate omissions, each of which would be a contract violation if present:
 *  - no `initialInput`: registration never sends a turn into Lance's conversation;
 *  - no `sdk` block: the public validator forbids it on a non-SDK driver, and
 *    there is no model for HRC to select — desktop chose it;
 *  - `harnessTransport: 'pipes'`, not `in-process`: the same validator admits
 *    in-process only for `pi-sdk` / `agent-harness`;
 *  - `process.command` is a descriptive sentinel. Nothing execs it. The real
 *    bundle path lives in the private driver block, where it is observation
 *    material rather than a launch instruction.
 */
export function buildDesktopObserverPlan(input: {
  readonly registration: DesktopThreadRegistration
  readonly session: HrcSessionRecord
  readonly runtimeId: string
  readonly runId: string
  readonly driver: CodexDesktopDriverSpec
  readonly now: string
}): DesktopObserverPlan {
  const invocationId = `inv-${randomUUID()}`
  const identity = {
    requestId: `req-${randomUUID()}`,
    operationId: `op-${randomUUID()}`,
    hostSessionId: input.session.hostSessionId,
    generation: input.session.generation,
    runtimeId: input.runtimeId,
    invocationId,
    runId: input.runId,
    traceId: `trace-${randomUUID()}`,
  } as RuntimeIdentityAllocation

  const spec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: {
      frontend: CODEX_DESKTOP_BROKER_DRIVER,
      provider: 'openai',
      driver: CODEX_DESKTOP_BROKER_DRIVER,
    },
    process: {
      command: 'external-codex-desktop',
      args: [],
      cwd: input.registration.projectRoot,
      lockedEnv: {},
      harnessTransport: { kind: 'pipes' },
    },
    interaction: {
      mode: 'service',
      turnConcurrency: 'single',
      inputQueue: 'fifo',
    },
    driver: input.driver,
    agent: {
      agentId: input.registration.agentId,
      projectId: input.registration.projectId,
      projectRoot: input.registration.projectRoot,
      runMode: 'task',
      scopeRef: input.session.scopeRef,
      laneRef: input.session.laneRef,
      runId: input.runId,
      hostSessionId: input.session.hostSessionId,
      generation: input.session.generation,
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      runtimeId: identity.runtimeId,
      runId: identity.runId,
      scopeRef: input.session.scopeRef,
      laneRef: input.session.laneRef,
      nativeThreadId: input.registration.nativeThreadId,
    },
  } as unknown as HarnessInvocationSpec

  const startRequest: InvocationStartRequest = { spec }
  const specHash = neutralSpecHash(spec)
  const startRequestHash = neutralStartRequestHash(startRequest)
  const profileId = `profile_${hashValue({
    driver: CODEX_DESKTOP_BROKER_DRIVER,
    startRequest: hashNeutralStartRequest(startRequest),
  }).slice(0, 32)}`
  const compatibilityHash = hashValue({
    driver: CODEX_DESKTOP_BROKER_DRIVER,
    threadId: input.driver.threadId,
    codexHome: input.driver.codexHome,
  })

  const profileMaterial = {
    schemaVersion: 'agent-runtime-profile/v1' as const,
    profileId: profileId as BrokerExecutionProfile['profileId'],
    kind: 'harness-broker' as const,
    // `headless` is the third value, and the only one that fits. The public
    // validator reserves `nonInteractive` for pi-sdk profiles
    // (`non_pi_sdk_forbids_non_interactive`) and requires an operator-attachable
    // tmux terminal for `interactive` (`interactive_broker_requires_tmux_terminal`).
    // A `pipes`-transport observer with no terminal is neither. Non-TUI
    // `codex-app-server` profiles declare `headless` for the same reason
    // (agent-spaces compile-runtime-plan.ts:1120).
    interactionMode: 'headless' as const,
    expectedCapabilities: {
      input: {
        // Queue-only admission: a broker input for this thread becomes a native
        // desktop queue entry at a FUTURE turn. There is no path that steers,
        // appends context, or attaches anything into a conversation HRC does
        // not own, so every other input kind is forbidden rather than optional.
        user: 'required' as const,
        steer: 'forbidden' as const,
        appendContext: 'forbidden' as const,
        localImages: 'forbidden' as const,
        fileRefs: 'forbidden' as const,
        queue: 'required' as const,
      },
      // Desktop owns interruption. HRC must not be able to request it.
      turns: { concurrency: 'single' as const, interrupt: 'forbidden' as const },
      continuation: 'optional' as const,
      permissions: 'none' as const,
      events: {
        assistantDeltas: 'optional' as const,
        toolCalls: 'required' as const,
        usage: 'optional' as const,
        diagnostics: 'optional' as const,
      },
      control: {
        stop: 'optional' as const,
        dispose: 'optional' as const,
        reconcile: 'optional' as const,
        attachReplay: 'optional' as const,
      },
      lifecycle: {
        // keep-alive is required, not preferred: HRC materializes only the
        // conservative overlay for broker routes, and an observer that HRC is
        // allowed to recycle is an observer that can vanish under a live
        // desktop conversation.
        runtimeRetention: ['keep-alive'],
        harnessRecovery: ['none'],
        turnRetry: ['none'],
        generationFencing: 'forbidden' as const,
        permissionCancellation: 'forbidden' as const,
      },
    },
    brokerProtocol: 'harness-broker/0.2' as const,
    brokerDriver: CODEX_DESKTOP_BROKER_DRIVER,
    // The BROKER process is HRC-owned — this field is about the broker, not
    // about the desktop thread. External ownership of the THREAD is carried by
    // runtimeStateJson.lifecycleOwner, which the HRC guards actually read.
    brokerOwnership: 'hrc-owned-process' as const,
    harnessInvocation: { startRequest, specHash, startRequestHash },
    policy: {
      permissionPolicy: { mode: 'deny' as const, audit: true as const },
      inputPolicy: {
        ...DEFAULT_CODEX_BROKER_INPUT_POLICY,
        supportedKinds: ['user'] as const,
        attachmentPolicy: { localImages: false, fileRefs: false },
      },
      exposurePolicy: { mode: 'none' as const },
    },
    observability: {
      correlation: {
        requestId: identity.requestId,
        operationId: identity.operationId,
        hostSessionId: identity.hostSessionId,
        generation: identity.generation,
        runtimeId: identity.runtimeId,
        runId: identity.runId,
        invocationId: invocationId as NonNullable<RuntimeIdentityAllocation['invocationId']>,
        traceId: identity.traceId,
      },
    },
  }
  const profileHash = (
    project(
      {
        ...profileMaterial,
        compatibilityHash,
        observability: { correlation: { generation: identity.generation } },
      },
      'profile'
    ) as { profileHash: string }
  ).profileHash
  const profile = {
    ...profileMaterial,
    profileHash,
    compatibilityHash,
  } as unknown as BrokerExecutionProfile
  const diagnostics = validateBrokerExecutionProfile(profile)
  if (diagnostics.length > 0) {
    throw new Error(`invalid codex-desktop observer profile: ${JSON.stringify(diagnostics)}`)
  }

  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v1' as const,
    compiler: { name: 'agent-spaces' as const, version: 'codex-desktop-observer/1' },
    compileId: `compile_${hashValue({
      driver: CODEX_DESKTOP_BROKER_DRIVER,
      threadId: input.driver.threadId,
    }).slice(0, 32)}`,
    createdAt: input.now,
    identity,
    placement: {
      projectRoot: input.registration.projectRoot,
      cwd: input.registration.projectRoot,
      runMode: 'task',
    },
    resolvedBundle: { bundleIdentity: compatibilityHash },
    harness: { family: 'codex' as const, runtime: 'codex-desktop' as const, provider: 'openai' },
    model: { provider: 'openai', modelId: 'desktop-owned', requestedModel: 'desktop-owned' },
    executionProfiles: [profile],
    artifacts: { bundleIdentity: compatibilityHash },
    lockedEnv: { lockedEnvKeys: [] },
    diagnostics: [],
  }
  const planHash = (project(planMaterial, 'plan') as { planHash: string }).planHash
  const plan = { ...planMaterial, planHash } as unknown as CompiledRuntimePlan

  return { plan, profile, startRequest, specHash, startRequestHash, identity }
}

export type DesktopObserverAttachment =
  | { readonly attached: true; readonly runtime: HrcRuntimeSnapshot }
  | { readonly attached: false; readonly reason: string; readonly detail: string }

/**
 * Attach (or reattach) HRC's observer to a registered desktop conversation.
 *
 * Failure here is DEGRADED OBSERVATION, never a statement about desktop and
 * never a reason to undo a registration. The permanent address is already
 * committed by the time this runs; an unavailable driver, an unreadable rollout
 * or a broker that will not start leaves the conversation addressable and the
 * observation visibly unattached, which is exactly the split §5 requires
 * ("A helper process is not desktop liveness").
 */
export async function attachDesktopObserver(
  this: HrcServerInstanceForHandlers,
  input: {
    readonly registration: DesktopThreadRegistration
    readonly driver: CodexDesktopDriverSpec
  }
): Promise<DesktopObserverAttachment> {
  const session = this.db.sessions.getByHostSessionId(input.registration.hostSessionId)
  if (session === null) {
    return {
      attached: false,
      reason: 'session_missing',
      detail: `registered session ${input.registration.hostSessionId} is absent`,
    }
  }
  const runtimeId = `rt-${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const now = timestamp()

  let built: DesktopObserverPlan
  try {
    built = buildDesktopObserverPlan({
      registration: input.registration,
      session,
      runtimeId,
      runId,
      driver: input.driver,
      now,
    })
  } catch (error) {
    return {
      attached: false,
      reason: 'observer_plan_invalid',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const controller = this.getHarnessBrokerController()
  const result = await controller.start({
    // T-08294: ownership is a START INPUT, not a post-start patch. The runtime
    // row is inserted by `persistStartGraph` before `startInvocationFromRequest`
    // is even awaited, and the broker `onClose` handler is registered before
    // that — so stamping ownership on the RETURNED runtime would leave a real
    // window in which a crash, an observer exit, or a post-start admission
    // failure projects terminal state onto a runtime every guard reads as
    // HRC-owned. See the regression in t08294-desktop-observer-ownership.test.ts.
    lifecycleOwner: 'external',
    plan: built.plan,
    profile: built.profile,
    startRequest: built.startRequest,
    specHash: built.specHash,
    startRequestHash: built.startRequestHash,
    identity: built.identity,
    routeDecision: {
      route: 'broker',
      selectedBy: 'registerDesktopThread',
      headlessRoute: 'durable-leased',
      brokerTransport: 'unix-jsonrpc-ndjson',
      operatorPresentation: 'none',
      lifecycleOwner: 'external',
    },
    lifecyclePolicy: resolveLifecyclePolicyOverlay({
      routeId: `codex-desktop-observer:${CODEX_DESKTOP_BROKER_DRIVER}`,
      brokerRoute: true,
    }),
  })

  if (!result.ok) {
    writeServerLog('WARN', 'desktop_observer.attach_failed', {
      scopeRef: input.registration.scopeRef,
      nativeThreadId: input.registration.nativeThreadId,
      code: result.error.code,
      message: result.error.message,
    })
    return { attached: false, reason: result.error.code, detail: result.error.message }
  }

  const attached = markDesktopRuntimeExternallyOwned(this, result.runtime, input.registration)
  writeServerLog('INFO', 'desktop_observer.attached', {
    scopeRef: input.registration.scopeRef,
    nativeThreadId: input.registration.nativeThreadId,
    runtimeId: attached.runtimeId,
  })
  return { attached: true, runtime: attached }
}

/**
 * Add the desktop projection to an already-owned observer runtime.
 *
 * `lifecycleOwner` is NOT established here — it is a start input, stamped at
 * row insert (see the comment at the `controller.start` call above). This write
 * is additive diagnostic state, and it re-asserts the field only so that a
 * runtime reaching this function can never be observed without it; if this is
 * the first place the guard appears, something upstream regressed.
 */
export function markDesktopRuntimeExternallyOwned(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  registration: DesktopThreadRegistration
): HrcRuntimeSnapshot {
  const now = timestamp()
  server.db.runtimes.update(runtime.runtimeId, {
    updatedAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      lifecycleOwner: 'external',
      origin: 'codex-desktop-registration',
      codexDesktop: {
        registrationKey: registration.registrationKey,
        nativeThreadId: registration.nativeThreadId,
        homeIdentity: registration.homeIdentity,
        projectId: registration.projectId,
        slotToken: registration.slotToken,
        // Carried so the DETACH handler can measure how far this observer had
        // read before it died. Without a watermark a replacement observer
        // re-projects the whole rollout and every historical turn lands twice.
        ...(registration.rolloutPath === undefined
          ? {}
          : { rolloutPath: registration.rolloutPath }),
        // Observation health is recorded separately from desktop availability
        // on purpose (§5). `observerAttachedAt` is a fact about HRC; it is not
        // evidence that the desktop thread is alive, loaded, or idle.
        observerAttachedAt: now,
      },
      updatedAt: now,
    },
  })
  return server.db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
}

export const desktopObserverHandlersMethods = {
  attachDesktopObserver,
}

export type DesktopObserverHandlersMethods = typeof desktopObserverHandlersMethods
