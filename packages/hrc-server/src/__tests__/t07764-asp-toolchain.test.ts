import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client'
import {
  ASP_TOOLCHAIN_BINARY_KINDS,
  observeAspToolchainHello,
  projectAspToolchainStatus,
  resolveAspToolchainBinary,
} from '../asp-toolchain'
import {
  type DurableTmuxManagerLike,
  allocateBrokerSubstrate,
} from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import type { BrokerWindowIdentity } from '../broker/controller'
import {
  assertAspcFacadeHello,
  resolveAspcFacadeStartOptions,
  startAspcFacadeBrokerClient,
} from '../option-resolvers'

import {
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures'
import {
  FakeBrokerClient,
  NOW,
  invocationCapabilities,
  makeFixture,
} from './fixtures/broker-controller.fixture'

const ENV_NAMES = [
  'HRC_ASP_TOOLCHAIN_ROOT',
  'HRC_ASPC_FACADE_CMD',
  'HRC_HARNESS_BROKER_CMD',
  'HRC_HARNESS_BROKER_PI_CMD',
  'HRC_AGENT_HARNESS_CMD',
] as const

let root = ''
let overrideRoot = ''
const savedEnv = new Map<string, string | undefined>()

async function installExecutables(directory: string): Promise<void> {
  for (const name of ASP_TOOLCHAIN_BINARY_KINDS) {
    const path = join(directory, name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
  }
}

beforeAll(async () => {
  for (const name of ENV_NAMES) savedEnv.set(name, process.env[name])
  root = await mkdtemp(join(tmpdir(), 'hrc-t07764-root-'))
  overrideRoot = await mkdtemp(join(tmpdir(), 'hrc-t07764-override-'))
  await installExecutables(root)
  await installExecutables(overrideRoot)
})

afterAll(async () => {
  restoreProcessEnv()
  await rm(root, { recursive: true, force: true })
  await rm(overrideRoot, { recursive: true, force: true })
})

function restoreProcessEnv(): void {
  for (const name of ENV_NAMES) {
    const value = savedEnv.get(name)
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
}

function cleanEnv(): Record<string, string | undefined> {
  return {}
}

describe.serial('T-07764 ASP toolchain selection', () => {
  it('uses override > root > bundled for every binary kind', () => {
    for (const kind of ASP_TOOLCHAIN_BINARY_KINDS) {
      const bundled = resolveAspToolchainBinary(kind, cleanEnv())
      expect(bundled.source).toBe('bundled')
      expect(basename(bundled.path)).toBe(kind)

      const fromRoot = resolveAspToolchainBinary(kind, { HRC_ASP_TOOLCHAIN_ROOT: root })
      expect(fromRoot).toMatchObject({ source: 'toolchain-root', path: join(root, kind) })

      const overrideEnv = fromRoot.envVar
      const overridePath = join(overrideRoot, kind)
      const overridden = resolveAspToolchainBinary(kind, {
        HRC_ASP_TOOLCHAIN_ROOT: root,
        [overrideEnv]: overridePath,
      })
      expect(overridden).toMatchObject({ source: 'env-override', path: overridePath })
    }
  })

  it('fails closed with a typed remedy for a missing root binary', () => {
    const missingRoot = join(root, 'missing')
    expect(() =>
      resolveAspToolchainBinary('harness-broker', { HRC_ASP_TOOLCHAIN_ROOT: missingRoot })
    ).toThrow(HrcRuntimeUnavailableError)
    try {
      resolveAspToolchainBinary('harness-broker', { HRC_ASP_TOOLCHAIN_ROOT: missingRoot })
    } catch (error) {
      expect(error).toBeInstanceOf(HrcRuntimeUnavailableError)
      expect((error as Error).message).toContain('build agent-spaces / check the root')
      expect((error as HrcRuntimeUnavailableError).detail).toMatchObject({
        root: missingRoot,
        binary: 'harness-broker',
      })
    }
  })

  it('uses the external contract-drift remedy for an aspc-facade hello mismatch', () => {
    const selection = resolveAspToolchainBinary('aspc-facade', {
      HRC_ASP_TOOLCHAIN_ROOT: root,
    })
    expect(() =>
      assertAspcFacadeHello(selection, {
        facadeInfo: { name: 'aspc-facade', version: 'external-test' },
        protocolVersion: 'aspc/1',
        capabilities: {
          compileRuntimePlan: true,
          catalogAgents: true,
          inspectAgent: true,
          catalogAgentInspection: true,
          inspectAgentSelection: true,
          compileHarnessInvocation: true,
          compileAndStart: false,
          cohostedBroker: false,
          transports: ['stdio-jsonrpc-ndjson'],
        },
      } as never)
    ).toThrow(
      'contract drift between resident hrc and external ASP toolchain: pull-deps + restart hrc, or align agent-spaces'
    )
  })

  it('runs the full precedence matrix through aspc-facade start options', () => {
    const bundled = resolveAspcFacadeStartOptions(cleanEnv())
    expect(basename(bundled.command)).toBe('aspc-facade')
    expect(resolveAspcFacadeStartOptions({ HRC_ASP_TOOLCHAIN_ROOT: root }).command).toBe(
      join(root, 'aspc-facade')
    )
    expect(
      resolveAspcFacadeStartOptions({
        HRC_ASP_TOOLCHAIN_ROOT: root,
        HRC_ASPC_FACADE_CMD: join(overrideRoot, 'aspc-facade'),
      }).command
    ).toBe(join(overrideRoot, 'aspc-facade'))
  })

  it('resolves the full precedence matrix at each real aspc-facade spawn', async () => {
    const commands: string[] = []
    const startSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async (options) => {
      commands.push(options.command)
      return {
        hello: async () => ({
          protocolVersion: ASPC_PROTOCOL_VERSION,
          facadeInfo: { name: 'aspc-facade', version: 'test' },
          capabilities: { compileHarnessInvocation: true, cohostedBroker: true },
        }),
        close: async () => undefined,
      } as unknown as AspcFacadeBrokerClient
    })
    try {
      for (const name of ENV_NAMES) Reflect.deleteProperty(process.env, name)
      await (await startAspcFacadeBrokerClient()).close()
      process.env['HRC_ASP_TOOLCHAIN_ROOT'] = root
      await (await startAspcFacadeBrokerClient()).close()
      process.env['HRC_ASPC_FACADE_CMD'] = join(overrideRoot, 'aspc-facade')
      await (await startAspcFacadeBrokerClient()).close()

      expect(commands[0]).toContain('/node_modules/.bin/aspc-facade')
      expect(commands[1]).toBe(join(root, 'aspc-facade'))
      expect(commands[2]).toBe(join(overrideRoot, 'aspc-facade'))
    } finally {
      startSpy.mockRestore()
      restoreProcessEnv()
    }
  })

  it('runs the full precedence matrix through the durable allocator spawn command', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'hrc-t07764-durable-'))
    const commands: string[] = []
    const manager: DurableTmuxManagerLike = {
      initialize: async () => {},
      createWindowWithCommand: async (input): Promise<BrokerWindowIdentity> => {
        commands.push(input.command)
        return {
          socketPath: join(runtimeRoot, 'tmux.sock'),
          sessionId: '$1',
          windowId: '@1',
          paneId: '%1',
          sessionName: input.sessionName,
          windowName: input.windowName,
        }
      },
      createOrInspectWindow: async () => {
        throw new Error('presentation=none must not create a TUI')
      },
    }
    const allocate = async (runtimeId: string, driverKind: string): Promise<void> => {
      await allocateBrokerSubstrate(
        { runtimeRoot },
        { tmuxManagerFactory: () => manager, generateAttachToken: () => 'token' },
        {
          runtimeId,
          hostSessionId: 'hostSession_w2',
          generation: 1,
          driverKind,
          endpoint: 'unix-jsonrpc-ndjson',
          presentation: 'none',
        }
      )
    }
    try {
      const drivers = [
        {
          kind: 'codex-app-server',
          binary: 'harness-broker',
          overrideEnv: 'HRC_HARNESS_BROKER_CMD',
        },
        { kind: 'pi-sdk', binary: 'harness-broker-pi', overrideEnv: 'HRC_HARNESS_BROKER_PI_CMD' },
        { kind: 'agent-harness', binary: 'agent-harness', overrideEnv: 'HRC_AGENT_HARNESS_CMD' },
      ] as const
      for (const driver of drivers) {
        for (const name of ENV_NAMES) Reflect.deleteProperty(process.env, name)
        const offset = commands.length
        await allocate(`rt-${driver.kind}-bundled`, driver.kind)
        process.env['HRC_ASP_TOOLCHAIN_ROOT'] = root
        await allocate(`rt-${driver.kind}-root`, driver.kind)
        process.env[driver.overrideEnv] = join(overrideRoot, driver.binary)
        await allocate(`rt-${driver.kind}-override`, driver.kind)

        expect(commands[offset]).toContain(`/node_modules/.bin/${driver.binary}`)
        expect(commands[offset + 1]).toContain(join(root, driver.binary))
        expect(commands[offset + 2]).toContain(join(overrideRoot, driver.binary))
      }
    } finally {
      restoreProcessEnv()
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('runs the full precedence matrix at each legacy stdio spawn', async () => {
    const rows = [
      { env: cleanEnv(), expected: '/node_modules/.bin/harness-broker' },
      { env: { HRC_ASP_TOOLCHAIN_ROOT: root }, expected: join(root, 'harness-broker') },
      {
        env: {
          HRC_ASP_TOOLCHAIN_ROOT: root,
          HRC_HARNESS_BROKER_CMD: join(overrideRoot, 'harness-broker'),
        },
        expected: join(overrideRoot, 'harness-broker'),
      },
    ]

    for (const [index, row] of rows.entries()) {
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
      const identity = makeIdentity({
        runtimeId: `runtime-toolchain-${index}` as never,
        invocationId: `invocation-toolchain-${index}` as never,
        operationId: `operation-toolchain-${index}` as never,
        runId: `run-toolchain-${index}` as never,
      })
      const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
      const compiled = makeCompileResponse(identity, [profile])
      if (!compiled.ok) throw new Error('fixture compile failed')
      const controller = new HarnessBrokerController({
        db: fixture.db,
        env: row.env,
        brokerClientFactory: async (options) => {
          commands.push(options.command)
          return fake
        },
        tmuxAllocator: {
          allocate: async () => ({
            socketPath: '/tmp/hrc-t07764-legacy.sock',
            allocatedAt: NOW,
            generation: 1,
          }),
        },
        now: () => NOW,
      })
      try {
        const result = await controller.start({
          plan: compiled.plan,
          profile,
          startRequest,
          specHash: profile.harnessInvocation.specHash,
          startRequestHash: profile.harnessInvocation.startRequestHash,
          identity,
        })
        expect(result.ok).toBe(true)
        expect(commands).toHaveLength(1)
        expect(commands[0]).toContain(row.expected)
      } finally {
        await fixture.cleanup()
      }
    }
  })

  it('preserves brokerCommand as a constant resolver-backed test seam', async () => {
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
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
    const compiled = makeCompileResponse(identity, [profile])
    if (!compiled.ok) throw new Error('fixture compile failed')
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerCommand: '/test/seam/harness-broker',
      brokerClientFactory: async (options) => {
        commands.push(options.command)
        return fake
      },
      tmuxAllocator: {
        allocate: async () => ({
          socketPath: '/tmp/hrc-t07764-test-seam.sock',
          allocatedAt: NOW,
          generation: 1,
        }),
      },
      now: () => NOW,
    })
    try {
      const result = await controller.start({
        plan: compiled.plan,
        profile,
        startRequest,
        specHash: profile.harnessInvocation.specHash,
        startRequestHash: profile.harnessInvocation.startRequestHash,
        identity,
      })
      expect(result.ok).toBe(true)
      expect(commands).toEqual(['/test/seam/harness-broker'])
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports current resolver output, bundled skew context, and observed hello identity', () => {
    const selection = resolveAspToolchainBinary('harness-broker', {
      HRC_ASP_TOOLCHAIN_ROOT: root,
    })
    observeAspToolchainHello(selection, {
      name: 'harness-broker',
      version: 'external-test',
      protocolVersion: 'harness-broker/0.2',
    })
    const report = projectAspToolchainStatus(
      {
        schema: 1,
        repository: 'agent-spaces',
        canonicalRemote: 'origin',
        sourceCommit: 'asp-commit',
        setName: 'asp',
        setVersion: 'asp-bundled',
        builtAt: NOW,
      },
      { HRC_ASP_TOOLCHAIN_ROOT: root }
    )
    expect(report.toolchainRootActive).toBe(true)
    expect(report.bundledAspBuild?.setVersion).toBe('asp-bundled')
    expect(report.binaries.find((entry) => entry.kind === 'harness-broker')).toMatchObject({
      source: 'toolchain-root',
      path: join(root, 'harness-broker'),
      hello: {
        name: 'harness-broker',
        version: 'external-test',
        protocolVersion: 'harness-broker/0.2',
      },
    })
  })
})
