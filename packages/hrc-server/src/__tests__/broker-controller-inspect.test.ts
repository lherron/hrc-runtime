/**
 * W3B green tests for HarnessBrokerController.
 *
 * These use a fake BrokerClient; no live broker process or route wiring is
 * involved. The controller remains inert unless W4 explicitly calls it behind
 * HRC_HEADLESS_CODEX_BROKER_ENABLED.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type {
  InvocationInspectionSummary,
  InvocationLifecycleView,
  InvocationLivenessView,
} from 'spaces-harness-broker-protocol'

import { BrokerControllerError, HarnessBrokerController } from '../broker/controller'

import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  makeFixture,
  makeStartInput,
  resolveWithin,
} from './fixtures/broker-controller.fixture'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('HarnessBrokerController', () => {
  describe('inspection read model — listInvocations', () => {
    it('returns InvocationInspectionSummary[] from the broker client', async () => {
      const fake = new FakeBrokerClient()
      // Broker advertises listInvocations so the controller serves it over the wire.
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'none',
            eventTypeFilter: false,
          },
        },
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      const summary: InvocationInspectionSummary = {
        invocationId: 'invocation_w2' as InvocationInspectionSummary['invocationId'],
        state: 'ready',
        driver: 'codex-app-server',
        startedAt: NOW,
        lastActivityAt: NOW,
      }
      fake.listInvocationsResponse = { invocations: [summary] }

      // RED: controller.listInvocations does not exist yet
      const result = await (controller as any).listInvocations('runtime_w2')

      expect(result).toEqual([summary])
      expect(fake.listInvocationsCalls).toHaveLength(1)
    })

    it('does NOT mutate runtime or session DB state', async () => {
      const fake = new FakeBrokerClient()
      // Advertise listInvocations so the no-mutation guard exercises a real
      // broker round-trip rather than the older-broker degrade path.
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'none',
            eventTypeFilter: false,
          },
        },
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      const runtimeBefore = fixture.db.runtimes.getByRuntimeId('runtime_w2')
      const sessionBefore = fixture.db.sessions.getByHostSessionId('hostSession_w2')
      const invocationBefore = fixture.db.brokerInvocations.getByInvocationId('invocation_w2')

      fake.listInvocationsResponse = { invocations: [] }

      // RED: controller.listInvocations does not exist yet
      await (controller as any).listInvocations('runtime_w2')

      // DB state must be byte-for-byte identical after the read-only call
      expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')).toEqual(runtimeBefore)
      expect(fixture.db.sessions.getByHostSessionId('hostSession_w2')).toEqual(sessionBefore)
      expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')).toEqual(
        invocationBefore
      )
    })

    it('returns an error (not throws) when the runtime is not active', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })

      // No start() — 'runtime_w2' is not active
      // RED: controller.listInvocations does not exist yet
      const result = await (controller as any).listInvocations('runtime_w2')

      expect(result.ok).toBe(false)
      expect(result.error).toBeInstanceOf(BrokerControllerError)
    })

    it('older broker (no inspection block): degrades cleanly without throwing and returns empty', async () => {
      const fake = new FakeBrokerClient()
      // Default helloResponse has NO inspection field → behaves like an older broker
      expect((fake.helloResponse.capabilities as any).inspection).toBeUndefined()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.listInvocations does not exist yet;
      // when implemented: must return [] without calling fake.listInvocations
      const result = await (controller as any).listInvocations('runtime_w2')

      expect(Array.isArray(result)).toBe(true)
      // Broker must NOT be called when inspection is not advertised
      expect(fake.listInvocationsCalls).toHaveLength(0)
    })

    it('times out a wedged listInvocations and retires the binding (T-07077)', async () => {
      // A reaped broker can leave its socket open with no EOF. Before T-07077 this
      // await was unbounded, so the HTTP handler blocked forever (observed live at
      // 524s) and `hrc run` hung after `/quit` with no summary and no shell prompt.
      class HangingListInvocationsBrokerClient extends FakeBrokerClient {
        override async listInvocations(): Promise<never> {
          this.callOrder.push('listInvocations')
          return new Promise<never>(() => {})
        }
      }
      const fake = new HangingListInvocationsBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'none',
            eventTypeFilter: false,
          },
        },
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
        serverInstanceId: 'server-test',
        brokerActiveRpcTimeoutMs: 25,
      } as any)
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      const startedAt = Date.now()
      const result = await resolveWithin((controller as any).listInvocations('runtime_w2'), 200)

      expect(result).not.toBe('test_watchdog_timeout')
      if (result === 'test_watchdog_timeout') return
      expect(Date.now() - startedAt).toBeLessThan(200)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('broker_list_invocations_timeout')

      // The wedged binding is retired, so it cannot poison every later request.
      const again = await (controller as any).listInvocations('runtime_w2')
      expect(again.ok).toBe(false)
      if (!again.ok) expect(again.error.code).toBe('broker_runtime_not_active')
    })
  })

  describe('inspection read model — status with probeLiveness', () => {
    it('plumbs probeLiveness: true into client.status() and returns extended summary fields', async () => {
      const fake = new FakeBrokerClient()
      const lifecycle: InvocationLifecycleView = {
        retention: { mode: 'keep-alive' },
        harnessRecovery: { mode: 'restart' },
        turnRetry: { mode: 'none' },
      }
      const liveness: InvocationLivenessView = {
        mode: 'probe',
        checkedAt: NOW,
        driver: { state: 'healthy' },
      }
      fake.statusResponse = {
        ...fake.statusResponse,
        lifecycle,
        liveness,
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.status currently ignores extra args;
      // when implemented: must forward probeLiveness to client.status()
      const result = await (controller as any).status('runtime_w2', { probeLiveness: true })

      expect(result.ok).toBe(true)
      // The broker client must have received probeLiveness: true
      const statusCall = fake.statusCalls.find((c) => c.probeLiveness === true)
      expect(statusCall).toBeDefined()
      expect(statusCall?.probeLiveness).toBe(true)
      // The response must carry the extended InvocationInspectionSummary fields
      expect(result.response.invocation?.lifecycle).toEqual(lifecycle)
      expect(result.response.invocation?.liveness).toEqual(liveness)
    })

    it('does NOT forward probeLiveness when called without the option', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      await controller.status('runtime_w2')

      // probeLiveness must be absent/falsy when not requested
      expect(fake.statusCalls.every((c) => !c.probeLiveness)).toBe(true)
    })
  })

  describe('inspection read model — snapshot', () => {
    it('returns InvocationSnapshot via a direct client.snapshot() call', async () => {
      const fake = new FakeBrokerClient()
      const lifecycle: InvocationLifecycleView = {
        retention: { mode: 'keep-alive' },
        harnessRecovery: { mode: 'restart' },
        turnRetry: { mode: 'none' },
      }
      fake.snapshotResponse = {
        ...fake.snapshotResponse,
        lifecycle,
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })
      fake.snapshotCalls.length = 0

      // RED: controller.snapshot does not exist yet
      const result = await (controller as any).snapshot('runtime_w2')

      expect(result.ok).toBe(true)
      expect(result.response.lifecycle).toEqual(lifecycle)
      // Must have called snapshot exactly once with the right invocationId
      expect(fake.snapshotCalls).toHaveLength(1)
      expect(fake.snapshotCalls[0]?.invocationId).toBe('invocation_w2')
    })

    it('snapshot does NOT call eventsSince or ackEvents (direct read, no replay)', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.snapshot does not exist yet;
      // when implemented: must be a direct snapshot() only — no replay machinery
      await (controller as any).snapshot('runtime_w2')

      expect(fake.callOrder).not.toContain('eventsSince')
      expect(fake.callOrder).not.toContain('ackEvents')
      expect(fake.callOrder).toContain('snapshot')
    })

    it('snapshot does NOT mutate runtime or session DB state', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      const runtimeBefore = fixture.db.runtimes.getByRuntimeId('runtime_w2')
      const sessionBefore = fixture.db.sessions.getByHostSessionId('hostSession_w2')
      const invocationBefore = fixture.db.brokerInvocations.getByInvocationId('invocation_w2')

      // RED: controller.snapshot does not exist yet
      await (controller as any).snapshot('runtime_w2')

      expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')).toEqual(runtimeBefore)
      expect(fixture.db.sessions.getByHostSessionId('hostSession_w2')).toEqual(sessionBefore)
      expect(fixture.db.brokerInvocations.getByInvocationId('invocation_w2')).toEqual(
        invocationBefore
      )
    })

    it('snapshot returns an error (not throws) when the runtime is not active', async () => {
      const fake = new FakeBrokerClient()
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })

      // No start() — runtime_w2 not active
      // RED: controller.snapshot does not exist yet
      const result = await (controller as any).snapshot('runtime_w2')

      expect(result.ok).toBe(false)
      expect(result.error).toBeInstanceOf(BrokerControllerError)
    })
  })

  describe('capability tri-state gating', () => {
    it('inspection.liveness === probe: controller passes probeLiveness: true on listInvocations', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'probe',
            eventTypeFilter: false,
          },
        },
      }
      fake.listInvocationsResponse = { invocations: [] }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.listInvocations does not exist yet
      await (controller as any).listInvocations('runtime_w2', { probeLiveness: true })

      // With liveness:'probe', controller must honor the caller's flag
      expect(fake.listInvocationsCalls).toHaveLength(1)
      expect(fake.listInvocationsCalls[0]?.probeLiveness).toBe(true)
    })

    it('inspection.liveness === cached: controller does NOT pass probeLiveness on listInvocations', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'cached',
            eventTypeFilter: false,
          },
        },
      }
      fake.listInvocationsResponse = { invocations: [] }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.listInvocations does not exist yet;
      // when implemented: cached → must NOT forward probeLiveness: true
      await (controller as any).listInvocations('runtime_w2', { probeLiveness: true })

      expect(fake.listInvocationsCalls).toHaveLength(1)
      expect(fake.listInvocationsCalls[0]?.probeLiveness).not.toBe(true)
    })

    it('inspection.liveness === none: controller omits probeLiveness on listInvocations', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: false,
            liveness: 'none',
            eventTypeFilter: false,
          },
        },
      }
      fake.listInvocationsResponse = { invocations: [] }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.listInvocations does not exist yet;
      // when implemented: none → must NOT forward probeLiveness
      await (controller as any).listInvocations('runtime_w2', { probeLiveness: true })

      expect(fake.listInvocationsCalls).toHaveLength(1)
      expect(fake.listInvocationsCalls[0]?.probeLiveness).not.toBe(true)
    })

    it('inspection.liveness === probe: controller passes probeLiveness: true on status()', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'probe',
            eventTypeFilter: false,
          },
        },
      }
      const liveness: InvocationLivenessView = {
        mode: 'probe',
        checkedAt: NOW,
        driver: { state: 'healthy' },
      }
      fake.statusResponse = { ...fake.statusResponse, liveness }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: controller.status currently ignores extra opts;
      // when implemented: must forward probeLiveness to client.status()
      await (controller as any).status('runtime_w2', { probeLiveness: true })

      const statusCall = fake.statusCalls.find((c) => c.probeLiveness === true)
      expect(statusCall).toBeDefined()
    })

    it('inspection.liveness === cached: controller does NOT probe on status()', async () => {
      const fake = new FakeBrokerClient()
      fake.helloResponse = {
        ...fake.helloResponse,
        capabilities: {
          ...fake.helloResponse.capabilities,
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'cached',
            eventTypeFilter: false,
          },
        },
      }
      const controller = new HarnessBrokerController({
        db: fixture.db,
        brokerClientFactory: async () => fake,
        now: () => NOW,
      })
      await controller.start({ ...makeStartInput(), brokerClient: fake })

      // RED: when implemented: cached → status must NOT request a live probe
      await (controller as any).status('runtime_w2', { probeLiveness: true })

      expect(fake.statusCalls.every((c) => !c.probeLiveness)).toBe(true)
    })
  })
  // ── end T-01855 reds ─────────────────────────────────────────────────────────

  it('fails closed when broker hello cannot admit the requested driver', async () => {
    const fake = new FakeBrokerClient()
    fake.emitCloseOnClose = true
    const infos: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const errors: Array<{ message: string; fields?: Record<string, unknown> }> = []
    fake.helloResponse = {
      ...fake.helloResponse,
      drivers: [{ kind: 'codex-app-server', version: '0.1.1-test', available: false }],
    }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      logger: {
        info(message, fields) {
          infos.push({ message, fields })
        },
        warn(message, fields) {
          warnings.push({ message, fields })
        },
        error(message, fields) {
          errors.push({ message, fields })
        },
      },
    })

    const result = await controller.start({ ...makeStartInput(), brokerClient: fake })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BrokerControllerError)
      expect(result.error.code).toBe('broker_admission_rejected')
      expect(result.error.detail['missing']).toEqual(['driver.codex-app-server.available'])
      expect(result.error.detail['protocolVersion']).toBe('harness-broker/0.2')
      expect(result.error.detail['driver']).toEqual(
        expect.objectContaining({ kind: 'codex-app-server', available: false })
      )
    }
    expect(fake.callOrder).toContain('close')
    expect(warnings.some((entry) => entry.message.includes('pre-start admission rejected'))).toBe(
      true
    )
    expect(infos.some((entry) => entry.message.includes('closed intentionally'))).toBe(true)
    expect(errors).toEqual([])
    expect(fixture.db.runtimes.getByRuntimeId('runtime_w2')).toBeNull()
  })
})
