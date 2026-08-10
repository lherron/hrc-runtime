import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type DurableTmuxManagerLike,
  allocateBrokerSubstrate,
  resolveBrokerBinary,
} from '../broker-interactive-handlers/substrate-allocator'
import type { BrokerWindowIdentity } from '../broker/controller'
import { resolvePiSdkBrokerEnabled } from '../option-resolvers'
import { HRC_PI_SDK_BROKER_ENABLED_ENV } from '../server-constants'

const originalFlag = process.env[HRC_PI_SDK_BROKER_ENABLED_ENV]

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env[HRC_PI_SDK_BROKER_ENABLED_ENV]
  } else {
    process.env[HRC_PI_SDK_BROKER_ENABLED_ENV] = originalFlag
  }
})

describe('pi-sdk broker flag resolution', () => {
  it('defaults OFF', () => {
    delete process.env[HRC_PI_SDK_BROKER_ENABLED_ENV]
    expect(resolvePiSdkBrokerEnabled({})).toBe(false)
  })

  it('enables only from an explicit truthy env value or option override', () => {
    process.env[HRC_PI_SDK_BROKER_ENABLED_ENV] = '1'
    expect(resolvePiSdkBrokerEnabled({})).toBe(true)
    expect(resolvePiSdkBrokerEnabled({ piSdkBrokerEnabled: false })).toBe(false)
  })
})

describe('pi-sdk broker binary mapping', () => {
  it('selects the composed pi broker binary only for pi-sdk', () => {
    expect(resolveBrokerBinary('pi-sdk')).toBe('harness-broker-pi')
  })

  for (const driver of ['codex-app-server', 'claude-code-tmux', 'codex-cli-tmux', 'pi-tui-tmux']) {
    it(`keeps ${driver} on the canonical broker binary`, () => {
      expect(resolveBrokerBinary(driver)).toBe('harness-broker')
    })
  }

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
      expect(commands[0]).toStartWith('exec harness-broker-pi run ')
      expect(allocation.brokerCommand).toBe(commands[0]!)
      expect(commands[0]).not.toContain('process-only-test-key')
      expect(environments).toEqual([{ OPENAI_API_KEY: 'process-only-test-key' }])
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })
})
