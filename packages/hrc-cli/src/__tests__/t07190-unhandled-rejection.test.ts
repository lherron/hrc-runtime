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
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

    expect(exitCode).toBe(1)
    expect(stderr).toContain('server.listening')
    expect(stderr).toContain('server.unhandled_rejection')
    expect(stderr).toContain('"decision":"fail_fast"')
    expect(stderr).toContain('"decision":"continue_shutdown"')
    expect(stderr).toContain('T-07190 outer rejection')
    expect(stderr).toContain('T-07190 inner cause')
    // T-09861: no grant was issued, so the fatal-policy shutdown is ungranted;
    // a caller-written file can no longer attribute it.
    expect(stderr).toContain('"grant":null')
    expect(stderr).not.toContain('"requestedBy"')
    expect(stderr).toContain('server.shutting_down')
    expect(stderr.indexOf('server.listening')).toBeLessThan(
      stderr.indexOf('server.unhandled_rejection')
    )
    expect(existsSync(join(runtimeRoot, 'server.pid'))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
