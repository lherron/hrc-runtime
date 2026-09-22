/**
 * T-08596 (T-08569A closure) — the ASP toolchain resolver is deleted: no
 * env-override / toolchain-root / bundled precedence, no facade start options,
 * no broker-binary mapping, no hello-identity status. The resolver governs
 * nothing on any node; every former fallback site refuses with the typed
 * `aspd_unconfigured` refusal, and admin status reports the resolver retired.
 */
import { describe, expect, it } from 'bun:test'

import { HrcRuntimeUnavailableError } from 'hrc-core'

import { ASP_TOOLCHAIN_BINARY_KINDS, projectAspToolchainStatus } from '../asp-toolchain'
import { HarnessBrokerController } from '../broker/controller'
import { aspdUnconfiguredError } from '../server-util'

import {
  makeHrcPolicy,
  makeIdentity,
  makeSelectedExecutionPlan,
  makeSelectedInteractiveTmuxExecution,
} from './broker-compile-fixtures'
import {
  FakeBrokerClient,
  NOW,
  invocationCapabilities,
  makeFixture,
} from './fixtures/broker-controller.fixture'

describe('T-08596 ASP toolchain closure', () => {
  it('names the retired binary kinds without resolving any of them', () => {
    expect([...ASP_TOOLCHAIN_BINARY_KINDS].sort()).toEqual(
      ['aspc-facade', 'harness-broker', 'harness-broker-pi'].sort()
    )
  })

  it('builds the typed aspd_unconfigured refusal every fallback site throws', () => {
    const error = aspdUnconfiguredError('broker-substrate', {
      hostSessionId: 'hsid-closure',
      runtimeId: 'rt-closure',
      driverKind: 'pi-sdk',
    })
    expect(error).toBeInstanceOf(HrcRuntimeUnavailableError)
    expect(error.message).toContain('aspd-independent execution closure')
    expect(error.detail).toMatchObject({
      code: 'aspd_unconfigured',
      route: 'aspd',
      site: 'broker-substrate',
      driverKind: 'pi-sdk',
    })
  })

  it('reports the resolver as retired with no selectable binaries', () => {
    expect(projectAspToolchainStatus()).toEqual({
      toolchainRootActive: false,
      binaries: [],
    })
  })

  it('refuses the legacy stdio spawn with the closure refusal instead of resolving harness-broker', async () => {
    const fixture = await makeFixture()
    const fake = new FakeBrokerClient()
    fake.helloResponse.drivers = [
      {
        kind: 'claude-code-tmux',
        version: 'test',
        available: true,
        capabilities: invocationCapabilities(),
      },
    ]
    const commands: string[] = []
    const identity = makeIdentity()
    const { execution } = makeSelectedInteractiveTmuxExecution(identity)
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async (options) => {
        commands.push(options.command)
        return fake
      },
      tmuxAllocator: {
        allocate: async () => ({
          socketPath: '/tmp/hrc-t08596-legacy.sock',
          allocatedAt: NOW,
          generation: 1,
        }),
      },
      now: () => NOW,
    })
    try {
      const result = await controller.start({
        execution,
        plan: makeSelectedExecutionPlan(),
        hrcPolicy: makeHrcPolicy(),
        identity,
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.code).toBe('broker_start_failed')
      expect(result.error.message).toContain('aspd-independent execution closure')
      expect(commands).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  it('preserves brokerCommand as a constant test seam', async () => {
    const fixture = await makeFixture()
    const fake = new FakeBrokerClient()
    fake.helloResponse.drivers = [
      {
        kind: 'claude-code-tmux',
        version: 'test',
        available: true,
        capabilities: invocationCapabilities(),
      },
    ]
    const commands: string[] = []
    const identity = makeIdentity()
    const { execution } = makeSelectedInteractiveTmuxExecution(identity)
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerCommand: '/test/seam/harness-broker',
      brokerClientFactory: async (options) => {
        commands.push(options.command)
        return fake
      },
      tmuxAllocator: {
        allocate: async () => ({
          socketPath: '/tmp/hrc-t08596-test-seam.sock',
          allocatedAt: NOW,
          generation: 1,
        }),
      },
      now: () => NOW,
    })
    try {
      const result = await controller.start({
        execution,
        plan: makeSelectedExecutionPlan(),
        hrcPolicy: makeHrcPolicy(),
        identity,
      })
      expect(result.ok).toBe(true)
      expect(commands).toEqual(['/test/seam/harness-broker'])
    } finally {
      await fixture.cleanup()
    }
  })
})
