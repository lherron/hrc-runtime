import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const MAIN_TS = join(import.meta.dir, '..', 'main.ts')

async function helpOutput(args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['bun', MAIN_TS, ...args, '--help'],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ASP_PROJECT: 'agent-spaces' },
  })
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode).toBe(0)
  return stdout
}

describe('hrcchat help text intent boundary', () => {
  it('top-level --help shows WORK / MESSAGES / LIVE / UTILITY groups', async () => {
    const out = await helpOutput([])
    expect(out).toContain('WORK')
    expect(out).toContain('MESSAGES')
    expect(out).toContain('LIVE')
    expect(out).toContain('UTILITY')
  })

  it('turn --help contains lead line about --stacked', async () => {
    const out = await helpOutput(['turn'])
    expect(out).toContain('--stacked')
    expect(out).toContain('Dispatch work to an agent')
    expect(out).toContain('force-flush lines on')
  })

  it('dm --help advertises --follow as the tracked-progress path', async () => {
    const out = await helpOutput(['dm'])
    expect(out).toContain('--follow <duration>')
    expect(out).toContain('tracked turn')
    expect(out).toContain('turn_stacked')
  })

  it('send --help contains NOT a turn warning', async () => {
    const out = await helpOutput(['send'])
    expect(out).toContain('NOT a turn')
    expect(out).toContain('hrcchat turn for work')
  })
})
