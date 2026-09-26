import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import type { HrcClient } from 'hrc-sdk'
import type { AttachDescriptor } from 'hrc-sdk'

import { bindGhosttySurfaceIfPresent } from '../cli/runtime-select'

const descriptor: AttachDescriptor = {
  transport: 'tmux',
  argv: ['tmux', 'attach'],
  bindingFence: {
    hostSessionId: 'hsid-tty',
    runtimeId: 'rt-tty',
    generation: 1,
  },
}

const originalGhosttySurface = process.env['GHOSTTY_SURFACE_UUID']
const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')

afterEach(() => {
  if (originalGhosttySurface === undefined) {
    Reflect.deleteProperty(process.env, 'GHOSTTY_SURFACE_UUID')
  } else {
    process.env['GHOSTTY_SURFACE_UUID'] = originalGhosttySurface
  }
  if (originalStdinTty === undefined) {
    Reflect.deleteProperty(process.stdin, 'isTTY')
  } else {
    Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
  }
})

describe('Ghostty attach binding terminal identity (T-09269)', () => {
  it('does not bind a Ghostty surface when no controlling TTY can be proven', async () => {
    process.env['GHOSTTY_SURFACE_UUID'] = 'ghostty-no-terminal-proof'
    const calls: unknown[] = []
    const client = {
      bindSurface: async (request: unknown) => {
        calls.push(request)
      },
    } as unknown as HrcClient

    await bindGhosttySurfaceIfPresent(client, descriptor)

    expect(calls).toEqual([])
  })

  it('binds the Ghostty surface with the exact proven controlling TTY', async () => {
    process.env['GHOSTTY_SURFACE_UUID'] = 'ghostty-proven-terminal'
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
    const spawnSync = spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout: new TextEncoder().encode('/dev/ttys042\n'),
    } as never)
    const calls: unknown[] = []
    const client = {
      bindSurface: async (request: unknown) => {
        calls.push(request)
      },
    } as unknown as HrcClient

    try {
      await bindGhosttySurfaceIfPresent(client, descriptor)
    } finally {
      spawnSync.mockRestore()
    }

    expect(calls).toEqual([
      {
        surfaceKind: 'ghostty',
        surfaceId: 'ghostty-proven-terminal',
        clientTty: '/dev/ttys042',
        hostSessionId: 'hsid-tty',
        runtimeId: 'rt-tty',
        generation: 1,
      },
    ])
  })
})
