import { describe, expect, it } from 'bun:test'
import type { HrcAttachDescriptor } from 'hrc-core'

import { createHrcTopActionExecutor } from './executor.js'

describe('hrc-top concrete action executor', () => {
  it('gets attach descriptors through HrcClient.attachRuntime and spawns returned argv', async () => {
    const calls: string[] = []
    const descriptor: HrcAttachDescriptor = {
      kind: 'exec',
      argv: ['tmux', 'attach-session', '-t', 'rt-live'],
      fence: { hostSessionId: 'hsid-1', generation: 1, runtimeId: 'rt-live' },
    }
    const executor = createHrcTopActionExecutor(
      {
        async attachRuntime(request) {
          calls.push(`attach:${request.runtimeId}`)
          return descriptor
        },
      },
      {
        beforeSpawn: () => calls.push('beforeSpawn'),
        afterSpawn: () => calls.push('afterSpawn'),
        spawn: (argv) => {
          calls.push(`spawn:${argv.join(' ')}`)
          return { exited: Promise.resolve(0) }
        },
      }
    )

    const returned = await executor.attachRuntime('rt-live')
    const result = await executor.spawnAttachDescriptor(returned)

    expect(result).toMatchObject({ status: 'executed' })
    expect(calls).toEqual([
      'attach:rt-live',
      'beforeSpawn',
      'spawn:tmux attach-session -t rt-live',
      'afterSpawn',
    ])
  })
})
