import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { copyCanonicalSourceSnapshot } from './atomic-install'

test('canonical snapshots rebuild changed crate inputs despite older commit timestamps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hrc-archive-cargo-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  const run = (command: string, args: string[], cwd = source) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
        CARGO_TARGET_DIR: target,
      },
    })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  try {
    await mkdir(join(source, 'src'), { recursive: true })
    await writeFile(
      join(source, 'Cargo.toml'),
      '[package]\nname="archive-cache-probe"\nversion="0.1.0"\nedition="2021"\n'
    )
    run('git', ['init', '-q'])
    run('git', ['config', 'user.name', 'Archive regression'])
    run('git', ['config', 'user.email', 'archive@example.invalid'])
    let cachedAt = 0
    for (const value of ['before', 'after']) {
      await writeFile(join(source, 'src/main.rs'), `fn main() { println!("${value}"); }\n`)
      run('git', ['add', 'Cargo.toml', 'src/main.rs'])
      run('git', ['commit', '-qm', value])
      const release = join(root, value)
      await mkdir(release)
      await copyCanonicalSourceSnapshot(source, release, run('git', ['rev-parse', 'HEAD']))
      if (cachedAt)
        expect((await stat(join(release, 'src/main.rs'))).mtimeMs).toBeGreaterThan(cachedAt)
      expect(run('cargo', ['run', '--offline', '--release', '--quiet'], release)).toBe(value)
      cachedAt = (await stat(join(target, 'release/archive-cache-probe'))).mtimeMs
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
