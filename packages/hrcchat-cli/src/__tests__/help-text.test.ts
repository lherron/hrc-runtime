/**
 * Flag-day surface conformance (T-07612 §9.2, T-07616).
 *
 * hrcchat is retired: `dm` forwards to `wrkc say` for the burn-in window, `turn`
 * survives only as the implementation behind `hrc turn`, and every other verb is
 * a hard fence that exits 2 naming its replacement. These assertions are what an
 * agent landing on the old spelling actually sees.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const MAIN_TS = join(import.meta.dir, '..', 'main.ts')

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ['bun', MAIN_TS, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ASP_PROJECT: 'agent-spaces' },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('hrcchat retirement surface', () => {
  it('top-level help is a migration map, not a command menu', async () => {
    const { stdout, exitCode } = await run(['--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('hrcchat is retired')
    expect(stdout).toContain('TALK -> wrkc')
    expect(stdout).toContain('LIVE RUNTIMES -> hrc')
    expect(stdout).toContain('GONE')
    expect(stdout).toContain('wrkc say')
    // The old grouped menu must not survive: it read as a supported surface.
    expect(stdout).not.toContain('UTILITY')
  })

  it('dm help documents the forwarding table and refuses --follow as a path', async () => {
    const { stdout, exitCode } = await run(['dm', '--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('forwards to')
    expect(stdout).toContain('wrkc say <target> --to <target>')
    expect(stdout).toContain('wrkc say lance --to lance')
    expect(stdout).toContain('hrc monitor watch EN-xxxxx')
  })

  it('info is the migration map and names wrkc as the collaboration surface', async () => {
    const { stdout, exitCode } = await run(['info'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('RETIRED')
    expect(stdout).toContain('wrkq owns collaboration; HRC owns execution')
    expect(stdout).toContain('hrcmail is deleted outright')
  })

  const moved: Array<[string, RegExp]> = [
    ['show', /wrkc show/],
    ['thread', /wrkc log/],
    ['messages', /wrkc ls/],
    ['summon', /hrc summon/],
    ['send', /hrc send/],
    ['peek', /hrc peek/],
    ['doctor', /hrc doctor/],
    ['trace', /federation message path/],
    ['who', /hrc target locate/],
  ]

  for (const [verb, replacement] of moved) {
    it(`${verb} exits 2 naming its replacement`, async () => {
      const { stdout, stderr, exitCode } = await run([verb, 'anything'])
      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(stderr).toMatch(new RegExp(`'hrcchat ${verb}' moved`))
      expect(stderr).toMatch(replacement)
    })

    it(`${verb} --help does not read as a supported alias`, async () => {
      const { stdout, exitCode } = await run([verb, '--help'])
      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
    })
  }
})
