import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { HRCCHAT_REDIRECT } from '../redirect.js'

const MAIN_TS = join(import.meta.dir, '..', 'main.ts')

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, MAIN_TS, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HRC_TURN_FORWARDED: '' },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('hrcchat retirement redirect', () => {
  const invocations: Array<[string, string[]]> = [
    ['bare', []],
    ['dm', ['dm', 'cody@hrc-runtime:primary', 'do not send']],
    ['turn', ['turn', 'cody@hrc-runtime:primary', 'do not dispatch']],
    ['messages', ['messages', '--limit', '1']],
    ['info', ['info']],
    ['unknown', ['frobnicate']],
    ['top-level help', ['--help']],
    ['verb help', ['dm', '--help']],
    ['global options', ['--json', '--project', 'hrc-runtime', 'info']],
  ]

  for (const [label, args] of invocations) {
    it(`${label} exits 2 with only the wrkc redirect on stderr`, async () => {
      const result = await run(args)

      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(HRCCHAT_REDIRECT)
    })
  }
})
