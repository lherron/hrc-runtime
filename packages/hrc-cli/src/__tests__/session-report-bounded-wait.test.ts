/**
 * T-05237 (daedalus required test #9): the consolidated headless viewer pane must
 * NOT be able to hold a pty indefinitely. The pane's terminal command ends with
 * `hrc session-report --wait-key --wait-timeout <n>`; this proves that the bounded
 * grace makes the command self-terminate even when no key is ever pressed and no
 * HRC server is reachable (the broker inspect fails fast and is swallowed).
 */
import { describe, expect, it } from 'bun:test'

import { cmdSessionReport } from '../cli/runtime-select'

describe('cmdSessionReport bounded --wait-key', () => {
  it('self-terminates within the grace window when no key is pressed', async () => {
    const originalWrite = process.stdout.write.bind(process.stdout)
    let output = ''
    // Swallow the report/keypress prompt output to keep test logs clean.
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk)
      return true
    }) as typeof process.stdout.write
    const start = Date.now()
    try {
      await cmdSessionReport([
        '--runtime',
        'rt-nonexistent-for-test',
        '--scope',
        'agent:test:project:hrc-runtime:task:T-05237',
        '--wait-key',
        '--wait-timeout',
        '1',
      ])
    } finally {
      process.stdout.write = originalWrite
    }
    const elapsed = Date.now() - start
    // Bounded: ~1s grace + a little slack for the (fast-failing) broker inspect.
    // The key assertion is that it RETURNS at all without a keypress — an unbounded
    // wait would block here forever.
    expect(elapsed).toBeLessThan(8000)
    expect(output).toContain('summary unavailable')
    expect(output).not.toContain('no summary recorded')
  })
})
