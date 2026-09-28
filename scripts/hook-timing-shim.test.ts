import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { environmentWithoutGitOverrides } from 'hrc-core'

/**
 * The real `.githooks` shims, run by real git, in a fixture repository.
 *
 * Failure modes this suite exists for (T-09847):
 *   - the shim changes the hook's exit status (a failed gate passes, or a
 *     failed post fails a passing hook);
 *   - a failed hook posts nothing, or a run posts more than once;
 *   - the shim consumes pre-push stdin, so code-validation sees no refs;
 *   - change_kind disagrees with what the gate decided;
 *   - a missing or broken wrkp blocks a commit.
 *
 * A fake `wrkp` first on PATH records its argv, so nothing reaches the real
 * ledger.
 */

interface Fixture {
  binDir: string
  postLog: string
  probeLog: string
  work: string
}

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })))
})

function resolveWorkspaceBinary(name: string): string {
  for (let directory = repoRoot; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', '.bin', name)
    if (existsSync(candidate)) return candidate
    if (dirname(directory) === directory) throw new Error(`cannot resolve ${name}`)
  }
}

const lefthookBinary = resolveWorkspaceBinary('lefthook')

function git(
  args: string[],
  cwd: string,
  env: Record<string, string> = {}
): { exitCode: number; output: string } {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...environmentWithoutGitOverrides(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  }
}

function ok(args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = git(args, cwd, env)
  expect(result.exitCode, `git ${args.join(' ')}\n${result.output}`).toBe(0)
  return result.output
}

async function makeFixture(wrkpBody: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'hrc-hook-timing-'))
  roots.push(root)
  const work = join(root, 'work')
  const remote = join(root, 'remote.git')
  const binDir = join(root, 'bin')
  const postLog = join(root, 'posts.log')
  const probeLog = join(root, 'probe.log')

  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, 'wrkp'), `#!/bin/sh\n${wrkpBody}\n`)
  // `probe <name>` logs its name and exits with $GATE_RC.
  await writeFile(
    join(binDir, 'probe'),
    `#!/bin/sh
printf '%s\\n' "$1" >> "$PROBE_LOG"
exit "\${GATE_RC:-0}"
`
  )
  await chmod(join(binDir, 'wrkp'), 0o755)
  await chmod(join(binDir, 'probe'), 0o755)

  ok(['init', '--bare', remote], root)
  ok(['init', '-b', 'main', work], root)
  ok(['config', 'user.name', 'Hook Test'], work)
  ok(['config', 'user.email', 'hook-test@example.com'], work)
  ok(['config', 'commit.gpgSign', 'false'], work)
  await mkdir(join(work, 'src'), { recursive: true })
  await writeFile(join(work, 'src', 'app.ts'), 'export const baseline = true\n')
  ok(['add', 'src/app.ts'], work)
  ok(['commit', '-m', 'baseline'], work)
  ok(['remote', 'add', 'origin', remote], work)
  ok(['push', '-u', 'origin', 'main'], work)

  // The shims and scripts under test, copied verbatim.
  await cp(join(repoRoot, '.githooks'), join(work, '.githooks'), { recursive: true })
  await cp(join(repoRoot, 'scripts', 'lib'), join(work, 'scripts', 'lib'), { recursive: true })
  for (const script of ['run-if-code-changed.ts', 'record-hook-timing.ts']) {
    await cp(join(repoRoot, 'scripts', script), join(work, 'scripts', script))
  }
  await cp(join(repoRoot, '.hookignore'), join(work, '.hookignore'))
  await mkdir(join(work, 'node_modules', '.bin'), { recursive: true })
  await symlink(lefthookBinary, join(work, 'node_modules', '.bin', 'lefthook'))
  await writeFile(join(work, '.gitignore'), 'node_modules/\n')
  await writeFile(
    join(work, 'lefthook.yml'),
    `min_version: "2.1.10"
pre-commit:
  parallel: false
  commands:
    gate:
      run: bun scripts/run-if-code-changed.ts pre-commit -- probe code
pre-push:
  parallel: false
  files: printf 'lefthook.yml\\n'
  commands:
    validation:
      use_stdin: true
      run: bun scripts/run-if-code-changed.ts pre-push -- probe validation {files}
`
  )
  ok(['config', 'core.hooksPath', '.githooks'], work)
  return { binDir, postLog, probeLog, work }
}

function env(fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${fixture.binDir}:${process.env['PATH'] ?? ''}`,
    POST_LOG: fixture.postLog,
    PROBE_LOG: fixture.probeLog,
    ...extra,
  }
}

async function lines(path: string): Promise<string[]> {
  return readFile(path, 'utf8')
    .then((text) => text.trim().split('\n').filter(Boolean))
    .catch(() => [])
}

/** The post is detached; wait for it rather than racing it. */
async function posts(fixture: Fixture, count: number): Promise<Map<string, string>[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await lines(fixture.postLog)).length >= count) break
    await Bun.sleep(50)
  }
  await Bun.sleep(100)
  return (await lines(fixture.postLog)).map((line) => {
    const args = JSON.parse(line) as string[]
    const attrs = new Map<string, string>()
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--attr') {
        const [key, ...value] = (args[index + 1] ?? '').split('=')
        attrs.set(key ?? '', value.join('='))
      } else if (args[index]?.startsWith('--') && args[index] !== '--attr') {
        attrs.set(args[index] ?? '', args[index + 1] ?? '')
      }
    }
    attrs.set('_project', args[1] ?? '')
    return attrs
  })
}

const recordingWrkp = `printf '%s\\n' "$(bun -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@")" >> "$POST_LOG"`

async function stageCode(fixture: Fixture, text: string): Promise<void> {
  await writeFile(join(fixture.work, 'src', 'app.ts'), `export const value = ${text}\n`)
  ok(['add', 'src/app.ts'], fixture.work)
}

describe('.githooks timing shim', () => {
  test('a passing commit posts exactly one hook.settled with the gate classification', async () => {
    const fixture = await makeFixture(recordingWrkp)
    await stageCode(fixture, "'passing'")
    ok(['commit', '-m', 'passing'], fixture.work, env(fixture))

    const [post, ...extra] = await posts(fixture, 1)
    expect(extra).toEqual([])
    expect(post?.get('_project')).toBe('hrc-runtime')
    expect(post?.get('--type')).toBe('hook.settled')
    expect(post?.get('--key')).toBe(`hook:${post?.get('run_id')}`)
    expect(post?.get('hook')).toBe('pre-commit')
    expect(post?.get('result')).toBe('passed')
    expect(post?.get('exit_code')).toBe('0')
    expect(post?.get('change_kind')).toBe('code')
    expect(post?.get('file_count')).toBe('1')
    expect(post?.get('branch')).toBe('main')
    expect(Number(post?.get('duration_ms'))).toBeGreaterThanOrEqual(0)
    for (const key of ['source', 'node', 'head', 'started_at', '--occurred-at']) {
      expect(post?.get(key), key).toBeTruthy()
    }
    expect(await lines(fixture.probeLog)).toEqual(['code'])
  })

  test('a failing commit keeps its exact status and posts result=failed', async () => {
    const fixture = await makeFixture(recordingWrkp)
    await stageCode(fixture, "'failing'")
    const result = git(['commit', '-m', 'failing'], fixture.work, env(fixture, { GATE_RC: '3' }))
    expect(result.exitCode).not.toBe(0)
    expect(ok(['rev-list', '--count', 'HEAD'], fixture.work).trim()).toBe('1')

    const [post, ...extra] = await posts(fixture, 1)
    expect(extra).toEqual([])
    expect(post?.get('result')).toBe('failed')
    expect(post?.get('exit_code')).not.toBe('0')
  })

  test('a broken or missing wrkp never changes a passing result', async () => {
    const broken = await makeFixture('exit 9')
    await stageCode(broken, "'broken'")
    ok(['commit', '-m', 'broken wrkp'], broken.work, env(broken))

    const missing = await makeFixture('')
    await rm(join(missing.binDir, 'wrkp'))
    await stageCode(missing, "'missing'")
    // The real wrkp must not be reachable either, and it shares a directory
    // with node on some hosts, so bun and node (lefthook's launcher) are
    // linked into a private directory instead of putting theirs on PATH.
    const tools = join(dirname(missing.binDir), 'tools')
    await mkdir(tools)
    for (const name of ['bun', 'node']) {
      await symlink(Bun.which(name) ?? name, join(tools, name))
    }
    const path = [missing.binDir, tools, '/usr/bin', '/bin'].join(':')
    expect(Bun.which('wrkp', { PATH: path })).toBeNull()
    ok(['commit', '-m', 'missing wrkp'], missing.work, { ...env(missing), PATH: path })
    expect(ok(['rev-list', '--count', 'HEAD'], missing.work).trim()).toBe('2')
  })

  test('pre-push stdin reaches code-validation untouched and the push posts once', async () => {
    const fixture = await makeFixture(recordingWrkp)
    await stageCode(fixture, "'pushed'")
    ok(['commit', '--no-verify', '-m', 'pushed'], fixture.work)
    ok(['push', 'origin', 'main'], fixture.work, env(fixture))

    expect(await lines(fixture.probeLog)).toEqual(['validation'])
    const [post, ...extra] = await posts(fixture, 1)
    expect(extra).toEqual([])
    expect(post?.get('hook')).toBe('pre-push')
    expect(post?.get('result')).toBe('passed')
    // Only the gate reads the pushed refs from stdin. Had the shim consumed
    // them, the gate would see none and classify the push as ambiguous.
    expect(post?.get('change_kind')).toBe('code')
    expect(post?.get('file_count')).toBe('1')
  })
})
