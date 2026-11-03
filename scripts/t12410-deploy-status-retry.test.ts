/** Drive the real deploy recipes with scripted status responses and no service mutations.
 * Failure modes: transient exit2 aborts; zero-exit degraded/malformed JSON is accepted;
 * failed snapshots leak to stdout; retry exhaustion runs deployment; identity/coherence
 * guards are weakened; remote retries depend on a script absent from an older checkout.
 */
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const realJust = Bun.which('just')!
const sha = 'a'.repeat(40)
const aspSha = 'b'.repeat(40)
const pin = '0.1.0-test'
const healthy = {
  status: 'healthy',
  node: { nodeId: 'max3' },
  release: { hrcBuild: { sourceCommit: sha }, runningEqualsInstalled: true },
  api: { aspd: { reachable: true, release: { sourceCommit: aspSha, releaseId: 'asp-test' } } },
}
const degraded = { ...healthy, status: 'degraded' }
type Frame = { exit: number; body: unknown }
const ok: Frame = { exit: 0, body: healthy }
const busy: Frame = { exit: 2, body: degraded }
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function run(recipe: string[], frames: Frame[]) {
  const root = mkdtempSync(join(tmpdir(), 't12410-status-'))
  roots.push(root)
  const bin = join(root, '.bun/bin')
  mkdirSync(bin, { recursive: true })
  for (const dir of [
    'praesidium/hrc-runtime/.git',
    'praesidium/agent-spaces/.git',
    'praesidium/var/aspd/service',
  ])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(
    join(root, 'praesidium/var/aspd/service/config.json'),
    JSON.stringify({ supervisor: { label: 'com.praesidium.aspd' } })
  )
  writeFileSync(join(root, 'frames.json'), JSON.stringify(frames))
  const executable = (name: string, body: string) => {
    const path = join(bin, name)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }
  executable(
    'hrc',
    `#!/usr/bin/python3
import json,os,pathlib,sys
root=pathlib.Path(os.environ['HOME']); counter=root/'count'
i=int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(i+1))
frames=json.loads((root/'frames.json').read_text()); f=frames[min(i,len(frames)-1)]
print(f['body'] if isinstance(f['body'],str) else json.dumps(f['body']))
sys.exit(f['exit'])
`
  )
  executable('sleep', '#!/bin/bash\nprintf "%s\\n" "$*" >> "$HOME/sleeps"\n')
  executable('launchctl', '#!/bin/bash\necho launchctl >> "$HOME/actions"\necho "pid = 123"\n')
  executable('ps', `#!/bin/bash\necho 'bunx hrc-mail-injector@${pin}'\n`)
  executable(
    'ssh',
    '#!/bin/bash\nset -eu\nwhile [[ "$1" == -o ]]; do shift 2; done\nshift\nexec "$@"\n'
  )
  executable(
    'git',
    `#!/bin/bash\ncase "$*" in *rev-parse*HEAD*) echo ${sha} ;; *rev-parse*) ref="\${!#}"; echo "\${ref%%^*}" ;; *fetch*|*merge-base*) exit 0 ;; *) exit 97 ;; esac\n`
  )
  executable(
    'just',
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$HOME/actions"\n[[ "$1" == _node-readback ]]\n'
  )
  executable('cargo', '#!/bin/bash\nexit 98\n')
  executable('bun', '#!/bin/bash\nexit 98\n')
  const result = Bun.spawnSync(
    [realJust, '--justfile', join(import.meta.dir, '../justfile'), ...recipe],
    {
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 18000,
    }
  )
  const read = (name: string) => {
    try {
      return readFileSync(join(root, name), 'utf8')
    } catch {
      return ''
    }
  }
  return {
    exit: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
    calls: Number(read('count')),
    sleeps: read('sleeps').trim().split('\n').filter(Boolean),
    actions: read('actions'),
  }
}

for (const [recipe, expected] of [
  ['_max3-source-commit', sha],
  ['_max3-aspd-commit', aspSha],
  ['_max3-injector-version', pin],
]) {
  test(`${recipe} tolerates four degraded probes and returns only the fifth healthy value`, () => {
    const r = run([recipe!], [busy, busy, busy, busy, ok])
    expect(r.exit).toBe(0)
    expect(r.out.trim()).toBe(expected!)
    expect(r.calls).toBe(5)
    expect(r.sleeps).toEqual(['3', '3', '3', '3'])
  }, 20000)
  test(`${recipe} refuses five unhealthy probes even with exit0`, () => {
    const r = run([recipe!], [{ exit: 0, body: degraded }])
    expect(r.exit).not.toBe(0)
    expect(r.out).toBe('')
    expect(r.calls).toBe(5)
    expect(r.sleeps).toEqual(['3', '3', '3', '3'])
    expect(r.actions).toBe('')
  }, 20000)
}

test('malformed status refuses after five attempts', () => {
  const r = run(['_max3-source-commit'], [{ exit: 0, body: 'not JSON' }])
  expect(r.exit).not.toBe(0)
  expect(r.calls).toBe(5)
  expect(r.out).toBe('')
}, 20000)

test('healthy status still refuses wrong node and incoherent release', () => {
  for (const body of [
    { ...healthy, node: { nodeId: 'svc' } },
    { ...healthy, release: { ...healthy.release, runningEqualsInstalled: false } },
  ]) {
    const r = run(['_max3-source-commit'], [{ exit: 0, body }])
    expect(r.exit).not.toBe(0)
    expect(r.calls).toBe(1)
    expect(r.out).toBe('')
  }
}, 20000)

const deploy = ['_deploy-node', 'mini', 'max3', sha, aspSha, pin, 'force', 'no-publish']
test('remote preflight retries degraded status without requiring a new script in the old checkout', () => {
  const r = run(deploy, [busy, ok])
  expect(r.exit).toBe(0)
  expect(r.out).toContain(`DEPLOY_TARGET_SHA=${sha}`)
  expect(r.actions).toContain('_node-readback mini max3')
  expect(r.sleeps).toEqual(['3'])
}, 20000)

test('remote preflight refuses after five failures before any deployment action', () => {
  const r = run(deploy, [busy])
  expect(r.exit).not.toBe(0)
  expect(r.calls).toBe(5)
  expect(r.actions).toBe('')
}, 20000)

test('aspd health read retries a degraded status snapshot', () => {
  const r = run(deploy, [ok, busy, ok])
  expect(r.exit).toBe(0)
  expect(r.actions).toContain('_node-readback mini max3')
  expect(r.sleeps).toEqual(['3'])
}, 20000)

test('existing aspd convergence loop survives an individual failed status read', () => {
  const r = run(deploy, [ok, ok, busy, ok])
  expect(r.exit).toBe(0)
  expect(r.actions).toContain('_node-readback mini max3')
  expect(r.sleeps).toEqual(['3'])
}, 20000)
