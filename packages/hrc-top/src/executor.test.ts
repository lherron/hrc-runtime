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

  it('returns bounded command failure detail with argv, exit status, and stderr summary', async () => {
    const calls: string[] = []
    const stderrText =
      'resume failed: continuation is stale and the selected runtime rejected the handoff'
    const encoder = new TextEncoder()
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(stderrText))
        controller.close()
      },
    })
    const executor = createHrcTopActionExecutor(
      {
        async attachRuntime() {
          throw new Error('attach is not used by this test')
        },
      },
      {
        spawn: ((argv, options) => {
          calls.push(`${argv.join(' ')} stderr:${options.stderr}`)
          return { exited: Promise.resolve(37), stderr }
        }) as NonNullable<Parameters<typeof createHrcTopActionExecutor>[1]>['spawn'],
      }
    )

    // T-05461 red bar: command-backed actions need structured failure detail
    // instead of only an inline footer reason.
    const result = await executor.runCommand(['hrc', 'resume', 'cody@hrc-runtime:T-05449'])
    const detail = (
      result as typeof result & {
        detail?: {
          argv?: string[]
          exitStatus?: number
          stderrSummary?: string
        }
      }
    ).detail

    expect(result).toMatchObject({
      status: 'disabled',
      reason: 'hrc resume cody@hrc-runtime:T-05449 exited with code 37.',
    })
    expect(detail).toMatchObject({
      argv: ['hrc', 'resume', 'cody@hrc-runtime:T-05449'],
      exitStatus: 37,
      stderrSummary: stderrText,
    })
    expect(calls).toEqual(['hrc resume cody@hrc-runtime:T-05449 stderr:pipe'])
  })
})
