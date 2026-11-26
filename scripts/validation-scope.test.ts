import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { environmentWithoutGitOverrides } from 'hrc-core'

const script = resolve(import.meta.dir, 'validation-scope.ts')
const repo = resolve(import.meta.dir, '..')

test('post-push scope uses CI BEFORE/SHA even when origin/main already equals HEAD', () => {
  const root = mkdtempSync('/tmp/hrc-verify-scope-')
  const env = environmentWithoutGitOverrides()
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }
  try {
    git('init', '-q')
    git('config', 'user.email', 'scope@example.test')
    git('config', 'user.name', 'Scope Test')
    for (const name of ['.hookignore', '.hookignore-cargo'])
      writeFileSync(join(root, name), readFileSync(join(repo, name)))
    writeFileSync(join(root, 'README.md'), '# seed\n')
    git('add', '.hookignore', '.hookignore-cargo', 'README.md')
    git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'seed')
    const ciScope = (before: string, sha: string) => {
      git('update-ref', 'refs/remotes/origin/main', sha)
      const result = Bun.spawnSync(['bun', script], {
        cwd: root,
        env: { ...env, GITHUB_ACTIONS: 'true', BEFORE: before, SHA: sha },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return result.stdout.toString().trim()
    }
    for (const [path, expected] of [
      ['packages/server/input.ts', 'HRC_VERIFY_TS=1\nHRC_VERIFY_CARGO=0'],
      ['crates/kernel/input.rs', 'HRC_VERIFY_TS=0\nHRC_VERIFY_CARGO=1'],
    ]) {
      const before = git('rev-parse', 'HEAD')
      const target = join(root, path as string)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, 'input\n')
      git('add', path as string)
      git(
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-qm',
        'pushed change'
      )
      expect(ciScope(before, git('rev-parse', 'HEAD'))).toBe(expected as string)
    }
    const rustCommit = git('rev-parse', 'HEAD')
    const beforeRust = git('rev-parse', 'HEAD^')
    git('rm', 'crates/kernel/input.rs')
    writeFileSync(join(root, 'README.md'), '# updated\n')
    git('add', 'README.md')
    git(
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'revert Rust'
    )
    const reverted = git('rev-parse', 'HEAD')
    expect(ciScope(beforeRust, reverted)).toBe('HRC_VERIFY_TS=0\nHRC_VERIFY_CARGO=1')
    expect(ciScope(rustCommit, reverted)).toBe('HRC_VERIFY_TS=0\nHRC_VERIFY_CARGO=1')
    expect(ciScope('0'.repeat(40), reverted)).toBe('HRC_VERIFY_TS=1\nHRC_VERIFY_CARGO=1')
    expect(ciScope('1'.repeat(40), reverted)).toBe('HRC_VERIFY_TS=1\nHRC_VERIFY_CARGO=1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
