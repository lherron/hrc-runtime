/** Drive real _node-readback with a healthy, already-current daemon and rotated logs.
 * Failure modes: empty grep silently aborts; rotated proof is lost; stale boots or
 * incomplete reattachment are accepted; missing proof lacks the paths searched.
 * SSH/status/supervisor are scripted; actual grep/zgrep/jq read private log files.
 */
import { expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const realJust = Bun.which('just')!
const sha = 'a'.repeat(40)
const aspSha = 'b'.repeat(40)
const started = '2026-11-03T15:20:08.160Z'
const warmup = (ts = '2026-11-03T15:20:10.000Z', attached = 2) =>
  JSON.stringify({ ts, event: 'broker.warmup.complete', data: { total: 2, attached } })

function replay(current: string, archived?: string) {
  const root = mkdtempSync(join(tmpdir(), 't12410-warmup-'))
  try {
    const bin = join(root, '.bun/bin')
    const repo = join(root, 'praesidium/hrc-runtime')
    const owner = join(root, 'praesidium/var/hrc-owner')
    const log = join(root, 'logs/rusthrc-owner.log')
    const archive = `${log}.20261103T155340Z.39061.gz`
    for (const dir of [
      bin,
      join(repo, 'scripts'),
      join(owner, 'bin'),
      join(root, 'logs'),
      join(root, 'Library/LaunchAgents'),
      join(root, '.bun/install/hrc-runtime-current/bin'),
    ])
      mkdirSync(dir, { recursive: true })
    writeFileSync(log, current)
    if (archived !== undefined) writeFileSync(archive, gzipSync(archived))
    writeFileSync(join(owner, 'bin/rusthrc'), '')
    writeFileSync(join(root, 'Library/LaunchAgents/com.praesidium.hrc-server.plist'), '')
    writeFileSync(
      join(repo, 'scripts/hrc-cli-path.sh'),
      readFileSync(join(import.meta.dir, 'hrc-cli-path.sh'))
    )
    const executable = (name: string, body: string) => {
      writeFileSync(join(bin, name), body)
      chmodSync(join(bin, name), 0o755)
    }
    const status = {
      status: 'healthy',
      node: { nodeId: 'svc' },
      pid: 25021,
      pidAlive: true,
      binaryPath: join(owner, 'bin/rusthrc'),
      release: {
        releasePath: join(owner, 'hrc-runtime-releases/release-test'),
        releaseId: 'release-test',
        hrcBuild: { sourceCommit: sha },
        runningEqualsInstalled: true,
        processStartedAt: started,
      },
      api: { aspd: { release: { sourceCommit: aspSha } } },
    }
    writeFileSync(join(root, 'status.json'), JSON.stringify(status))
    executable('rusthrc', '#!/bin/bash\ncat "$HOME/status.json"\n')
    symlinkSync(join(bin, 'rusthrc'), join(root, '.bun/install/hrc-runtime-current/bin/rusthrc'))
    symlinkSync('rusthrc', join(bin, 'hrc'))
    executable(
      'ssh',
      `#!/bin/bash
set -eu
while [[ "$1" == -o ]]; do shift 2; done
shift
exec "$@"
`
    )
    executable(
      'plutil',
      `#!/bin/bash
case "$2" in
 ProgramArguments) printf '["%s/praesidium/var/hrc-owner/bin/rusthrc"]\\n' "$HOME" ;;
 EnvironmentVariables) echo '{"HRC_TEST":"yes"}' ;;
 StandardOutPath) echo "$HOME/logs/rusthrc-owner.log" ;;
 ExitTimeOut) echo 45 ;;
 *) exit 97 ;;
esac
`
    )
    executable('launchctl', '#!/bin/bash\necho "pid = 25021"\n')
    executable('ps', '#!/bin/bash\necho "rusthrc HRC_TEST=yes"\n')
    executable('codesign', '#!/bin/bash\nexit 0\n')
    executable('sleep', '#!/bin/bash\necho sleep >> "$HOME/sleeps"\n')
    const r = Bun.spawnSync(
      [
        realJust,
        '--justfile',
        join(import.meta.dir, '../justfile'),
        '_node-readback',
        'mini',
        'svc',
        sha,
        aspSha,
        'asp-test',
        '',
        'no-publish',
      ],
      {
        env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20000,
      }
    )
    return { exit: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), log, archive }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('no-restart readback recovers this boot warmup from gzip after log rotation', () => {
  const r = replay('{"event":"http.request"}\n', `${warmup()}\n`)
  expect(r.exit).toBe(0)
  expect(r.out).toContain('brokers reattached: {"total":2,"attached":2}')
}, 30000)

test('missing warmup fails with all log paths searched', () => {
  const r = replay('', '{"event":"http.request"}\n')
  expect(r.exit).not.toBe(0)
  expect(r.err).toContain('no broker.warmup.complete')
  expect(r.err).toContain(r.log)
  expect(r.err).toContain(r.archive)
}, 30000)

test('previous boot warmup in gzip cannot satisfy the current boot', () => {
  const r = replay('', `${warmup('2026-11-01T21:21:18.000Z')}\n`)
  expect(r.exit).not.toBe(0)
  expect(r.err).toContain('no broker.warmup.complete')
  expect(r.err).toContain(started)
}, 30000)

test('rotated incomplete reattachment still refuses deployment', () => {
  const r = replay('', `${warmup(undefined, 1)}\n`)
  expect(r.exit).not.toBe(0)
  expect(r.err).toContain('brokers did not all reattach')
}, 30000)

test('unrotated current-boot warmup still passes without archives', () => {
  const r = replay(`${warmup()}\n`)
  expect(r.exit).toBe(0)
  expect(r.out).toContain('brokers reattached')
}, 30000)

test('missing warmup without any archives still fails with the current log path', () => {
  const r = replay('')
  expect(r.exit).not.toBe(0)
  expect(r.err).toContain('no broker.warmup.complete')
  expect(r.err).toContain(r.log)
}, 30000)
