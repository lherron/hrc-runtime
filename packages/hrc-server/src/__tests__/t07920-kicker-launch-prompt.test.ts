import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot } from 'hrc-core'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
} from 'spaces-aspc-protocol'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { makeCompileResponse, makeInteractiveTmuxProfile } from './broker-compile-fixtures.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:t07920:project:hrc-runtime:task:T-07920'
const PROFILE_PRIMING = 'Profile priming: begin the assigned task.'
const KICK = 'Message Type: MESSAGE\nTask name: T-07920\nImplement the requested change.'

const INTENT: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/t07920-agent',
    projectRoot: '/tmp/t07920-project',
    cwd: '/tmp/t07920-project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
  execution: { preferredMode: 'interactive' },
}

let fixture: HrcServerTestFixture
let server: HrcServer
let facadeSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07920-launch-prompt-')
  server = await createHrcServer(
    fixture.serverOpts({
      claudeCodeTmuxBrokerEnabled: true,
      brokerDurableIpcEnabled: false,
      otelListenerEnabled: false,
    })
  )
})

afterEach(async () => {
  facadeSpy?.mockRestore()
  await server.stop()
  await fixture.cleanup()
})

describe('T-07920 launch-primed cold summons', () => {
  it('compiles priming plus kick into launch material and creates no broker initialInput', async () => {
    let compileRequest: AspcCompileHarnessInvocationRequest['compileRequest'] | undefined
    let startedRequest: InvocationStartRequest | undefined
    facadeSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async () => {
      return {
        hello: async () => ({
          protocolVersion: ASPC_PROTOCOL_VERSION,
          facadeInfo: { name: 'aspc-facade', version: 't07920-test' },
          capabilities: { compileHarnessInvocation: true, cohostedBroker: true },
        }),
        compileHarnessInvocation: async (
          request: AspcCompileHarnessInvocationRequest
        ): Promise<AspcCompileHarnessInvocationResponse> => {
          compileRequest = request.compileRequest
          const identity = request.compileRequest.identity as RuntimeIdentityAllocation
          const caller = request.compileRequest.materialization.initialPrompt
          const { profile, startRequest } = makeInteractiveTmuxProfile(identity, {
            launchInitialPrompt: `${PROFILE_PRIMING}\n\n${caller}`,
            withInitialInput: false,
          })
          const compileResponse = makeCompileResponse(identity, [profile])
          if (!compileResponse.ok) throw new Error('T-07920 compile fixture rejected')
          return {
            schemaVersion: 'aspc-compile-harness-invocation-response/v1',
            ok: true,
            compileResponse,
            plan: compileResponse.plan,
            selectedProfile: profile,
            startRequest,
            dispatchRequest: { startRequest },
            diagnostics: compileResponse.diagnostics,
          }
        },
        close: async () => undefined,
      } as unknown as AspcFacadeBrokerClient
    })

    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as {
      db: {
        sessions: {
          getByHostSessionId(
            hostSessionId: string
          ): Awaited<ReturnType<HrcServerTestFixture['resolveSession']>> | null
        }
      }
      getHarnessBrokerController(): {
        start(input: {
          startRequest: InvocationStartRequest
          onAccepted?: (graph: { runtime: HrcRuntimeSnapshot }) => Promise<void> | void
        }): Promise<{ ok: true; runtime: HrcRuntimeSnapshot }>
      }
      startInteractiveTmuxBrokerRuntime(
        session: NonNullable<ReturnType<typeof internal.db.sessions.getByHostSessionId>>,
        intent: HrcRuntimeIntent,
        runId: string,
        options: {
          flagEnvName: string
          allowedBrokerDriver: 'claude-code-tmux'
          coldBirthPrompt: string
          onColdBirthPromptRoute(rodeLaunch: boolean): void
        }
      ): Promise<HrcRuntimeSnapshot>
    }
    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-07920 fixture session was not persisted')
    const runtime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-t07920',
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'starting',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: 'op-t07920',
      activeInvocationId: 'invocation_T1',
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    }
    internal.getHarnessBrokerController = () => ({
      start: async (input) => {
        startedRequest = input.startRequest
        await input.onAccepted?.({ runtime })
        return { ok: true, runtime }
      },
    })

    let rodeLaunch = false
    await internal.startInteractiveTmuxBrokerRuntime(session, INTENT, 'run-t07920', {
      flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
      allowedBrokerDriver: 'claude-code-tmux',
      coldBirthPrompt: KICK,
      onColdBirthPromptRoute: (value) => {
        rodeLaunch = value
      },
    })

    expect(rodeLaunch).toBe(true)
    expect(compileRequest?.materialization.initialPrompt).toBe(KICK)
    expect(startedRequest?.spec.launch?.initialPrompt).toBe(`${PROFILE_PRIMING}\n\n${KICK}`)
    expect(startedRequest?.initialInput).toBeUndefined()
    // The one-shot summons must not become reusable session authority.
    const persisted = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    expect(persisted?.lastAppliedIntentJson?.initialPrompt).toBeUndefined()
  })
})
