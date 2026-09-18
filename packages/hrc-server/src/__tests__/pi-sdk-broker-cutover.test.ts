/**
 * T-08596 (T-08569A closure) — the pi-sdk resolver arm is deleted along with
 * the toolchain resolver. A substrate allocation with no frozen worker launch
 * refuses with the typed `aspd_unconfigured` refusal (site `broker-substrate`)
 * for every driver kind, including pi-sdk; a frozen aspd worker launch still
 * allocates and launches EXACTLY its executable.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcRuntimeUnavailableError } from 'hrc-core'

import {
  type DurableTmuxManagerLike,
  allocateBrokerSubstrate,
  describeBrokerSubstratePaths,
} from '../broker-interactive-handlers/substrate-allocator'
import type { BrokerWindowIdentity } from '../broker/controller'

function substrateInput(
  runtimeId: string,
  driverKind: string,
  workerLaunch?: { executable: string; argv: string[] } | undefined
) {
  return {
    runtimeId,
    hostSessionId: 'hsid-pi-sdk-cutover',
    generation: 1,
    driverKind,
    endpoint: 'unix-jsonrpc-ndjson' as const,
    presentation: 'none' as const,
    brokerEnv: { OPENAI_API_KEY: 'process-only-test-key' },
    ...(workerLaunch !== undefined ? { workerLaunch } : {}),
  }
}

describe('broker substrate without a frozen worker launch (T-08596 closure)', () => {
  for (const driver of ['pi-sdk', 'codex-app-server', 'claude-code-tmux', 'pi-tui-tmux']) {
    it(`refuses ${driver} with aspd_unconfigured instead of resolving a broker binary`, async () => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'hrc-pi-cutover-'))
      try {
        const error = await allocateBrokerSubstrate(
          { runtimeRoot },
          {
            tmuxManagerFactory: () => {
              throw new Error('no spawn may precede the refusal')
            },
            generateAttachToken: () => 'pi-cutover-token',
          },
          substrateInput('rt-pi-sdk-cutover', driver)
        ).then(
          () => {
            throw new Error('allocation without a worker launch must refuse')
          },
          (error: unknown) => error
        )
        expect(error).toBeInstanceOf(HrcRuntimeUnavailableError)
        const detail = (error as HrcRuntimeUnavailableError).detail as Record<string, unknown>
        expect(detail).toMatchObject({
          code: 'aspd_unconfigured',
          route: 'aspd',
          site: 'broker-substrate',
          driverKind: driver,
        })
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    })
  }

  it('launches a frozen pi-sdk worker launch exactly, with no resolver consultation', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'hrc-pi-frozen-'))
    const runtimeId = 'rt-pi-sdk-frozen'
    const commands: string[] = []
    const manager: DurableTmuxManagerLike = {
      initialize: async () => {},
      createWindowWithCommand: async (input): Promise<BrokerWindowIdentity> => {
        commands.push(input.command)
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
      const paths = describeBrokerSubstratePaths({ runtimeRoot }, 'pi-sdk', runtimeId)
      const executable = '/bin/echo'
      const workerLaunch = {
        executable,
        argv: [
          executable,
          'run',
          '--socket',
          paths.brokerIpcSocketPath,
          '--event-ledger',
          paths.eventLedgerPath,
          '--runtime-id',
          runtimeId,
          '--host-session-id',
          'hsid-pi-sdk-cutover',
          '--generation',
          '1',
          '--attach-token-file',
          paths.attachTokenPath,
        ],
      }
      const allocation = await allocateBrokerSubstrate(
        { runtimeRoot },
        {
          tmuxManagerFactory: () => manager,
          generateAttachToken: () => 'pi-cutover-token',
        },
        substrateInput(runtimeId, 'pi-sdk', workerLaunch)
      )

      expect(commands).toHaveLength(1)
      expect(commands[0]).toContain(`'${executable}'`)
      expect(commands[0]).not.toContain('node_modules/.bin')
      expect(allocation.brokerCommand).toBe(commands[0]!)
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })
})
