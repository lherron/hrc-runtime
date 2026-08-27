import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { environmentWithoutGitOverrides } from 'hrc-core'

interface HookCommandConfig {
  files?: string
  run: string
  stage_fixed?: boolean
  use_stdin?: boolean
}

interface HookConfig {
  min_version: string
  'pre-commit': {
    commands: Record<string, HookCommandConfig>
  }
  'pre-push': {
    files: string
    commands: Record<string, HookCommandConfig>
  }
}

interface HookFixture {
  binDir: string
  logPath: string
  remote: string
  work: string
}

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const lefthookBinary = join(repoRoot, 'node_modules', '.bin', 'lefthook')
const scopeScript = join(repoRoot, 'scripts', 'run-if-code-changed.ts')
const codeOnlyPreCommitCommands = [
  'lint',
  'boundaries',
  'manifests',
  'cli-surface',
  'public-surface',
  'suppressions',
  'typecheck',
]
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true }))
  )
})

// The fixture's git commands mean the FIXTURE repo. Inheriting the ambient GIT_*
// would point them at the caller's repository instead — under a git hook, which is
// exactly where this suite runs, `git init` would re-initialize the real checkout
// and write core.bare into the config it shares with every worktree (T-07635).
function run(command: string[], cwd: string, env: Record<string, string | undefined> = {}): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...environmentWithoutGitOverrides(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  expect(result.exitCode, `${command.join(' ')}\n${output}`).toBe(0)
  return output
}

async function readConfig(): Promise<HookConfig> {
  return Bun.YAML.parse(await readFile(join(repoRoot, 'lefthook.yml'), 'utf8')) as HookConfig
}

async function readInvocations(logPath: string): Promise<string[]> {
  return readFile(logPath, 'utf8')
    .then((text) => text.trim().split('\n').filter(Boolean))
    .catch(() => [])
}

function hookEnvironment(fixture: HookFixture): Record<string, string> {
  return {
    HOOK_INVOCATIONS: fixture.logPath,
    PATH: `${fixture.binDir}:${process.env['PATH'] ?? ''}`,
  }
}

async function makeHookFixture(): Promise<HookFixture> {
  const root = await mkdtemp(join(tmpdir(), 'hrc-runtime-lefthook-'))
  temporaryRoots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  const binDir = join(root, 'bin')
  const logPath = join(root, 'invocations.log')

  await mkdir(binDir, { recursive: true })
  await writeFile(
    join(binDir, 'hook-probe'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HOOK_INVOCATIONS"
`
  )
  await chmod(join(binDir, 'hook-probe'), 0o755)

  run(['git', 'init', '--bare', remote], root)
  run(['git', 'init', '-b', 'main', work], root)
  run(['git', 'config', 'user.name', 'Hook Test'], work)
  run(['git', 'config', 'user.email', 'hook-test@example.com'], work)
  run(['git', 'config', 'commit.gpgSign', 'false'], work)
  await mkdir(join(work, 'src'), { recursive: true })
  await writeFile(join(work, 'README.md'), '# baseline\n')
  await writeFile(join(work, 'src', 'app.ts'), 'export const baseline = true\n')
  run(['git', 'add', 'README.md', 'src/app.ts'], work)
  run(['git', 'commit', '-m', 'baseline'], work)
  run(['git', 'remote', 'add', 'origin', remote], work)
  run(['git', 'push', '-u', 'origin', 'main'], work)

  await mkdir(join(work, 'scripts'), { recursive: true })
  await writeFile(join(work, 'scripts', 'run-if-code-changed.ts'), await readFile(scopeScript))
  await writeFile(
    join(work, 'lefthook.yml'),
    `min_version: "2.1.10"
pre-commit:
  parallel: false
  commands:
    gitleaks:
      run: hook-probe gitleaks
    code:
      run: bun scripts/run-if-code-changed.ts pre-commit -- hook-probe code
pre-push:
  parallel: false
  files: printf 'lefthook.yml\\n'
  commands:
    validation:
      use_stdin: true
      run: bun scripts/run-if-code-changed.ts pre-push -- sh -c 'hook-probe validation' {files}
`
  )
  run([lefthookBinary, 'install'], work)

  return { binDir, logPath, remote, work }
}

async function commit(
  fixture: HookFixture,
  message: string,
  paths: string[],
  verify = false
): Promise<string[]> {
  run(['git', 'add', '--all', '--', ...paths], fixture.work)
  await writeFile(fixture.logPath, '')
  run(
    ['git', 'commit', ...(verify ? [] : ['--no-verify']), '-m', message],
    fixture.work,
    hookEnvironment(fixture)
  )
  return readInvocations(fixture.logPath)
}

async function push(fixture: HookFixture, args: string[] = ['origin']): Promise<string[]> {
  await writeFile(fixture.logPath, '')
  run(['git', 'push', ...args], fixture.work, hookEnvironment(fixture))
  return readInvocations(fixture.logPath)
}

describe('lefthook v2 configuration', () => {
  test('pins the installed major and validates the configuration', async () => {
    const packageJson = (await Bun.file(join(repoRoot, 'package.json')).json()) as {
      devDependencies: Record<string, string>
    }
    const config = await readConfig()

    expect(packageJson.devDependencies['lefthook']).toBe('2.1.10')
    expect(config.min_version).toBe('2.1.10')
    run([lefthookBinary, 'validate'], repoRoot)
  })

  test('keeps secret scanning unconditional and wraps every code check', async () => {
    const commands = (await readConfig())['pre-commit'].commands

    expect(commands['gitleaks']?.run).toBe('gitleaks protect --staged --redact')
    for (const name of codeOnlyPreCommitCommands) {
      expect(commands[name]?.run, name).toStartWith(
        'bun scripts/run-if-code-changed.ts pre-commit -- '
      )
    }
  })

  test('uses one fail-safe pre-push stdin consumer and preserves TMPDIR', async () => {
    const prePush = (await readConfig())['pre-push']
    expect(prePush.files).toBe("printf 'lefthook.yml\\n'")
    expect(prePush.commands).toEqual({
      'code-validation': {
        use_stdin: true,
        run: "bun scripts/run-if-code-changed.ts pre-push -- sh -c 'bun install && TMPDIR=/tmp bun run test:fast' {files}",
      },
    })
  })
})

describe('lefthook v2 real pre-commit boundaries', () => {
  test('runs only secret scanning for documentation extensions regardless of case', async () => {
    const fixture = await makeHookFixture()
    await mkdir(join(fixture.work, 'docs'), { recursive: true })
    const files = ['README.MARKDOWN', 'docs/Reference.HTML', 'docs/notes.TxT', 'docs/legacy.HtM']
    for (const file of files) await writeFile(join(fixture.work, file), 'documentation\n')

    expect(await commit(fixture, 'documentation files', files, true)).toEqual(['gitleaks'])
  })

  test('runs code checks for a code deletion', async () => {
    const fixture = await makeHookFixture()
    await rm(join(fixture.work, 'src', 'app.ts'))

    expect((await commit(fixture, 'delete code', ['src/app.ts'], true)).sort()).toEqual([
      'code',
      'gitleaks',
    ])
  })

  test('runs code checks for a code-to-document rename', async () => {
    const fixture = await makeHookFixture()
    await mkdir(join(fixture.work, 'docs'), { recursive: true })
    await rename(join(fixture.work, 'src', 'app.ts'), join(fixture.work, 'docs', 'app.md'))

    expect(
      (await commit(fixture, 'rename code to docs', ['src/app.ts', 'docs/app.md'], true)).sort()
    ).toEqual(['code', 'gitleaks'])
  })
})

describe('lefthook v2 real pre-push boundaries', () => {
  test('skips a documentation-only update on an existing branch', async () => {
    const fixture = await makeHookFixture()
    await writeFile(join(fixture.work, 'README.md'), '# docs update\n')
    await commit(fixture, 'docs update', ['README.md'])

    expect(await push(fixture)).toEqual([])
  })

  test('skips a documentation-only update on a new branch', async () => {
    const fixture = await makeHookFixture()
    run(['git', 'switch', '-c', 'docs-only'], fixture.work)
    await writeFile(join(fixture.work, 'README.md'), '# branch docs update\n')
    await commit(fixture, 'branch docs update', ['README.md'])

    expect(await push(fixture, ['origin', 'docs-only'])).toEqual([])
  })

  test('runs validation for a code update', async () => {
    const fixture = await makeHookFixture()
    await writeFile(join(fixture.work, 'src', 'app.ts'), 'export const changed = true\n')
    await commit(fixture, 'code update', ['src/app.ts'])

    expect(await push(fixture)).toEqual(['validation'])
  })

  test('skips a deletion-only push', async () => {
    const fixture = await makeHookFixture()
    run(['git', 'branch', 'obsolete'], fixture.work)
    run(['git', 'push', '--no-verify', 'origin', 'obsolete'], fixture.work)

    expect(await push(fixture, ['origin', '--delete', 'obsolete'])).toEqual([])
  })

  test('runs validation when a code file is deleted', async () => {
    const fixture = await makeHookFixture()
    await rm(join(fixture.work, 'src', 'app.ts'))
    await commit(fixture, 'delete code', ['src/app.ts'])

    expect(await push(fixture)).toEqual(['validation'])
  })

  test('runs validation when code is renamed to documentation', async () => {
    const fixture = await makeHookFixture()
    await mkdir(join(fixture.work, 'docs'), { recursive: true })
    await rename(join(fixture.work, 'src', 'app.ts'), join(fixture.work, 'docs', 'app.md'))
    await commit(fixture, 'rename code to docs', ['src/app.ts', 'docs/app.md'])

    expect(await push(fixture)).toEqual(['validation'])
  })

  test('runs validation once when any ref in a multi-ref push changes code', async () => {
    const fixture = await makeHookFixture()
    run(['git', 'switch', '-c', 'docs-ref'], fixture.work)
    await writeFile(join(fixture.work, 'README.md'), '# multi-ref docs update\n')
    await commit(fixture, 'multi-ref docs', ['README.md'])
    run(['git', 'switch', 'main'], fixture.work)
    run(['git', 'switch', '-c', 'code-ref'], fixture.work)
    await writeFile(join(fixture.work, 'src', 'app.ts'), 'export const multiRef = true\n')
    await commit(fixture, 'multi-ref code', ['src/app.ts'])

    expect(
      await push(fixture, [
        'origin',
        'docs-ref:refs/heads/docs-ref',
        'code-ref:refs/heads/code-ref',
      ])
    ).toEqual(['validation'])
  })

  test('fails safe by running validation for malformed or empty stdin', async () => {
    const fixture = await makeHookFixture()
    const command = [
      'bun',
      'scripts/run-if-code-changed.ts',
      'pre-push',
      '--',
      'hook-probe',
      'validation',
    ]

    for (const stdin of [
      '',
      'malformed input\n',
      `(delete) 0 refs/heads/obsolete ${'a'.repeat(40)}\n`,
    ]) {
      await writeFile(fixture.logPath, '')
      const result = Bun.spawnSync(command, {
        cwd: fixture.work,
        env: { ...process.env, ...hookEnvironment(fixture) },
        stdin: Buffer.from(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(await readInvocations(fixture.logPath)).toEqual(['validation'])
    }
  })
})
