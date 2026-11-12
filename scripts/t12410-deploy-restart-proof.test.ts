/** Replay the observed max3 activation timeline through the real deploy recipe.
 * Grant 2026-11-03T15:15:24.535Z; warmup22/22 15:15:57.543Z (+33008ms).
 * Failure modes: default30s aborts before warmup, wait mode loses its drain bound,
 * permanent unhealthy process reaches readback, or restart runs in remote SSH.
 * Scripted lifecycle proof advances virtual time; no service is restarted.
 */
import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const realJust = Bun.which('just')!
const sha = 'a'.repeat(40)
const aspSha = 'b'.repeat(40)
const warmupMs = Date.parse('2026-11-03T15:15:57.543Z') - Date.parse('2026-11-03T15:15:24.535Z')

function replay(mode: string, unhealthy = false, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 't12410-proof-'))
  try {
    const bin = join(root, '.bun/bin')
    mkdirSync(bin, { recursive: true })
    const executable = (name: string, body: string) => {
      writeFileSync(join(bin, name), body)
      chmodSync(join(bin, name), 0o755)
    }
    executable(
      'ssh',
      `#!/bin/bash
set -eu
cat >/dev/null
case "$*" in
  *'-- kind') echo rusthrc ;;
  *'-- schema-state') echo current ;;
  *'-- stage '*) echo staged ;;
  *'-- log-mark') echo 0 ;;
  *'-- boot-check 0') echo booted ;;
  *) printf '%s\\n' 'DEPLOY_RESTART_NEEDED=1' 'DEPLOY_TARGET_SHA=${sha}' 'DEPLOY_ASPD_SHA=${aspSha}' 'DEPLOY_ASPD_RELEASE=asp-test' ;;
esac
`
    )
    executable(
      'hrc',
      `#!/usr/bin/python3
import json,pathlib,sys
args=sys.argv[1:]
pathlib.Path.home().joinpath('restart.json').write_text(json.dumps(args))
assert args[:2]==['server','restart']
bound=int(args[args.index('--proof-timeout-ms')+1]) if '--proof-timeout-ms' in args else 30000
if ${unhealthy ? 'True' : 'False'} or bound < ${warmupMs}:
 print('restart_unproven: no healthy new process within '+str(bound)+'ms',file=sys.stderr)
 sys.exit(1)
print('restart proven after ${warmupMs}ms: healthy new process')
`
    )
    executable('just', '#!/bin/bash\necho "$*" > "$HOME/readback"\n[[ "$1" == _node-readback ]]\n')
    let recipe = readFileSync(join(import.meta.dir, '../justfile'), 'utf8')
    if (legacy) recipe = recipe.replace('--proof-timeout-ms 120000', '')
    const justfile = join(root, 'justfile')
    writeFileSync(justfile, recipe)
    mkdirSync(join(root, 'scripts'))
    // The owner script is streamed to the fake peer, never executed.
    writeFileSync(join(root, 'scripts/hrc-owner.sh'), '')
    writeFileSync(
      join(root, 'scripts/hrc-cli-path.sh'),
      readFileSync(join(import.meta.dir, 'hrc-cli-path.sh'))
    )
    const result = Bun.spawnSync(
      [
        realJust,
        '--justfile',
        justfile,
        '_deploy-node',
        'max3',
        'max3',
        sha,
        aspSha,
        mode,
        'no-publish',
      ],
      {
        env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15000,
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
      args: JSON.parse(read('restart.json') || '[]') as string[],
      readback: read('readback'),
      err: result.stderr.toString(),
      out: result.stdout.toString(),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('observed 33008ms warmup reproduces the old 30s proof refusal', () => {
  expect(warmupMs).toBe(33008)
  const r = replay('force', false, true)
  expect(r.exit).not.toBe(0)
  expect(r.err).toContain('restart_unproven')
  expect(r.readback).toBe('')
}, 20000)

for (const mode of ['force', 'wait']) {
  test(`${mode}: proof outlasts observed warmup and retains restart mode`, () => {
    const r = replay(mode)
    expect(r.exit).toBe(0)
    expect(r.args).toContain('--proof-timeout-ms')
    expect(r.args[r.args.indexOf('--proof-timeout-ms') + 1]).toBe('120000')
    expect(r.args).toContain(`--${mode}`)
    if (mode === 'wait') expect(r.args[r.args.indexOf('--wait-timeout-ms') + 1]).toBe('300000')
    expect(r.out).toContain('restart proven after 33008ms')
    expect(r.readback).toContain('_node-readback max3 max3')
  }, 20000)
}

test('permanently unhealthy restart still refuses before readback', () => {
  const r = replay('force', true)
  expect(r.exit).not.toBe(0)
  expect(r.err).toContain('within 120000ms')
  expect(r.readback).toBe('')
}, 20000)
