import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')
const PRELOAD_PATH = join(import.meta.dir, 'fixtures', 'unhandled-rejection-preload.fixture.ts')

test('a booted foreground server handles rejected promises with deliberate fatal policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hrc-t07190-'))
  const runtimeRoot = join(root, 'runtime')
  const stateRoot = join(root, 'state')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })

  const env: Record<string, string | undefined> = {
    ...process.env,
    HRC_RUNTIME_DIR: runtimeRoot,
    HRC_STATE_DIR: stateRoot,
    HRC_SHADOW_TEARDOWN_ENABLED: '0',
    CLAUDECODE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined,
    CODEX_SANDBOX: undefined,
  }

  try {
    const child = Bun.spawn(
      [process.execPath, '--preload', PRELOAD_PATH, CLI_PATH, 'server', 'serve'],
      {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    // Server lines are the stdout half (T-10854); log is drained but unasserted.
    const [exitCode, log] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(1)
    expect(log).toContain('server.listening')
    expect(log).toContain('server.unhandled_rejection')
    expect(log).toContain('"decision":"fail_fast"')
    expect(log).toContain('"decision":"continue_shutdown"')
    expect(log).toContain('T-07190 outer rejection')
    expect(log).toContain('T-07190 inner cause')
    // T-09861: no grant was issued, so the fatal-policy shutdown is ungranted;
    // a caller-written file can no longer attribute it.
    expect(log).toContain('"grant":null')
    expect(log).not.toContain('"requestedBy"')
    expect(log).toContain('server.shutting_down')
    expect(log.indexOf('server.listening')).toBeLessThan(log.indexOf('server.unhandled_rejection'))
    expect(existsSync(join(runtimeRoot, 'server.pid'))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
