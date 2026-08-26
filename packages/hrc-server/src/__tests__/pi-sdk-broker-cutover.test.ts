import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

import {
  type DurableTmuxManagerLike,
  allocateBrokerSubstrate,
  resolveBrokerBinary,
} from '../broker-interactive-handlers/substrate-allocator'
import type { BrokerWindowIdentity } from '../broker/controller'
describe('broker binary mapping', () => {
  it('selects release-relative driver-specific broker binaries', () => {
    expect(isAbsolute(resolveBrokerBinary('pi-sdk'))).toBe(true)
    expect(basename(resolveBrokerBinary('pi-sdk'))).toBe('harness-broker-pi')
    expect(isAbsolute(resolveBrokerBinary('agent-harness'))).toBe(true)
    expect(basename(resolveBrokerBinary('agent-harness'))).toBe('agent-harness')
    expect(resolveBrokerBinary('agent-harness-tmux')).toBe(resolveBrokerBinary('agent-harness'))
  })

  for (const driver of ['codex-app-server', 'claude-code-tmux', 'codex-cli-tmux', 'pi-tui-tmux']) {
    it(`keeps ${driver} on the canonical broker binary`, () => {
      const binary = resolveBrokerBinary(driver)
      expect(isAbsolute(binary)).toBe(true)
      expect(basename(binary)).toBe('harness-broker')
    })
  }

  it('honors per-binary command overrides', () => {
    const priorAgentHarness = process.env['HRC_AGENT_HARNESS_CMD']
    const priorPi = process.env['HRC_HARNESS_BROKER_PI_CMD']
    const priorCanonical = process.env['HRC_HARNESS_BROKER_CMD']
    try {
      process.env['HRC_AGENT_HARNESS_CMD'] = '/overrides/agent-harness'
      process.env['HRC_HARNESS_BROKER_PI_CMD'] = '/overrides/harness-broker-pi'
      process.env['HRC_HARNESS_BROKER_CMD'] = '/overrides/harness-broker'
      expect(resolveBrokerBinary('agent-harness-tmux')).toBe('/overrides/agent-harness')
      expect(resolveBrokerBinary('pi-sdk')).toBe('/overrides/harness-broker-pi')
      expect(resolveBrokerBinary('codex-cli-tmux')).toBe('/overrides/harness-broker')
    } finally {
      process.env['HRC_AGENT_HARNESS_CMD'] = priorAgentHarness
      process.env['HRC_HARNESS_BROKER_PI_CMD'] = priorPi
      process.env['HRC_HARNESS_BROKER_CMD'] = priorCanonical
    }
  })

  it('places harness-broker-pi in the actual allocated broker command', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'hrc-pi-cutover-'))
    const commands: string[] = []
    const environments: Array<Record<string, string> | undefined> = []
    const manager: DurableTmuxManagerLike = {
      initialize: async () => {},
      createWindowWithCommand: async (input): Promise<BrokerWindowIdentity> => {
        commands.push(input.command)
        environments.push(input.env)
        return {
          socketPath: '/tmp/pi-sdk-btmux.sock',
          sessionId: '$1',
          windowId: '@1',
          paneId: '%1',
          sessionName: input.sessionName,
          windowName: input.windowName,
        }
      },
      createOrInspectWindow: async (): Promise<BrokerWindowIdentity> => {
        throw new Error('presentation=none must not allocate a TUI window')
      },
    }

    try {
      const allocation = await allocateBrokerSubstrate(
        { runtimeRoot },
        {
          tmuxManagerFactory: () => manager,
          generateAttachToken: () => 'pi-cutover-token',
        },
        {
          runtimeId: 'rt-pi-sdk-cutover',
          hostSessionId: 'hsid-pi-sdk-cutover',
          generation: 1,
          driverKind: 'pi-sdk',
          endpoint: 'unix-jsonrpc-ndjson',
          presentation: 'none',
          brokerEnv: { OPENAI_API_KEY: 'process-only-test-key' },
        }
      )

      expect(commands).toHaveLength(1)
      expect(commands[0]).toContain("/node_modules/.bin/harness-broker-pi' run ")
      expect(allocation.brokerCommand).toBe(commands[0]!)
      expect(commands[0]).not.toContain('process-only-test-key')
      expect(environments).toEqual([{ OPENAI_API_KEY: 'process-only-test-key' }])
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })
})
