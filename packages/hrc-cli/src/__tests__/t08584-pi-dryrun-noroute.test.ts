/** T-08584: a pi-shaped intent under --dry-run prints the no-route reason, never "spec build failed". */
import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'

import { printLocalRunPreview } from '../cli/handlers-scope-cmd'

function piShapedIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/t08584-agent',
      projectRoot: '/tmp/t08584-project',
      cwd: '/tmp/t08584-project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'pi', interactive: false },
    execution: { preferredMode: 'interactive' },
  } as HrcRuntimeIntent
}

describe('T-08584 pi dry-run no-route fallthrough', () => {
  it('prints the one-line no-route reason and no "spec build failed"', async () => {
    const chunks: string[] = []
    const originalWrite = process.stdout.write
    const originalRuntimeDir = process.env['HRC_RUNTIME_DIR']
    process.env['HRC_RUNTIME_DIR'] = `/tmp/t08584-no-daemon-${Date.now()}-${Math.random()}`
    process.stdout.write = ((chunk: unknown): boolean => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await printLocalRunPreview(
        'run',
        'piper@hrc-runtime:primary',
        'agent:piper:project:hrc-runtime:task:T-08584/lane:main',
        piShapedIntent(),
        'reuse_pty',
        undefined,
        undefined
      )
    } finally {
      process.stdout.write = originalWrite
      if (originalRuntimeDir === undefined) {
        process.env['HRC_RUNTIME_DIR'] = undefined
      } else {
        process.env['HRC_RUNTIME_DIR'] = originalRuntimeDir
      }
    }
    const output = chunks.join('')
    expect(output).toContain('no broker route for harness "pi"')
    expect(output).not.toContain('spec build failed')
  })
})
