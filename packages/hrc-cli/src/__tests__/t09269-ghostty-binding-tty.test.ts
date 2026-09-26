import { afterEach, describe, expect, it } from 'bun:test'
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

afterEach(() => {
  if (originalGhosttySurface === undefined) {
    Reflect.deleteProperty(process.env, 'GHOSTTY_SURFACE_UUID')
  } else {
    process.env['GHOSTTY_SURFACE_UUID'] = originalGhosttySurface
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
})
