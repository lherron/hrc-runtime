import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ProbeOverrides = Partial<Record<'max3' | 'mini' | 'hrcdev', string>>

interface FleetStatusRun {
  exitCode: number
  stderr: string
  stdout: string
  sshTargets: string[]
}

const temporaryRoots: string[] = []
const decoder = new TextDecoder()

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function runFleetStatus(
  driverNode: 'max3' | 'hrcdev',
  overrides: ProbeOverrides = {}
): FleetStatusRun {
  const root = mkdtempSync(join(tmpdir(), 't09272-fleet-status-'))
  temporaryRoots.push(root)
  const bin = join(root, '.bun', 'bin')
  mkdirSync(bin, { recursive: true })
  const tracePath = join(root, 'ssh-targets.log')

  writeExecutable(
    join(bin, 'hrc'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'node="${FAKE_NODE:?FAKE_NODE is required}"',
      'case "$node" in',
      '  max3) hrc_commit=4136d813; aspd_commit=d3e42545 ;;',
      '  mini) hrc_commit=8538f02a; aspd_commit=7390034a ;;',
      '  hrcdev) hrc_commit=6ee4ea67; aspd_commit=da52b1ac ;;',
      '  *) exit 64 ;;',
      'esac',
      'printf \'{"node":{"nodeId":"%s"},"status":"healthy","release":{"hrcBuild":{"sourceCommit":"%s"},"runningEqualsInstalled":true},"api":{"aspd":{"reachable":true,"release":{"sourceCommit":"%s"}}},"socketPath":"/tmp/t09272.sock"}\\n\' "$node" "$hrc_commit" "$aspd_commit"',
      '',
    ].join('\n')
  )

  writeExecutable(
    join(bin, 'ssh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'target=""',
      'for argument in "$@"; do',
      '  case "$argument" in',
      '    max3|mini|hrcdev) target="$argument" ;;',
      '  esac',
      'done',
      '[[ -n "$target" ]] || exit 64',
      'printf "%s\\n" "$target" >> "$FAKE_TRACE"',
      'case "$target" in',
      '  max3) node="${FAKE_SSH_MAX3_NODE:-max3}" ;;',
      '  mini) node="${FAKE_SSH_MINI_NODE:-mini}" ;;',
      '  hrcdev) node="${FAKE_SSH_HRCDEV_NODE:-hrcdev}" ;;',
      'esac',
      'remote_command="${!#}"',
      'FAKE_NODE="$node" /bin/bash -c "$remote_command"',
      '',
    ].join('\n')
  )

  writeExecutable(
    join(bin, 'zsh'),
    [
      '#!/usr/bin/env bash',
      'command="$*"',
      'if [[ "$command" == *\'bun --version\'* ]]; then',
      "  printf '1.3.14\\n0.154.0\\n2.1.283\\n'",
      'elif [[ "$command" == *\'whence -ap bunx\'* ]]; then',
      '  printf "%s\\n" "$HOME/.bun/bin/bunx"',
      'else',
      '  printf "%s\\n" "$HOME/.bun/bin/bun"',
      'fi',
      '',
    ].join('\n')
  )
  writeExecutable(join(bin, 'launchctl'), '#!/usr/bin/env bash\nexit 1\n')
  writeExecutable(join(bin, 'pgrep'), '#!/usr/bin/env bash\nexit 1\n')

  const child = Bun.spawnSync(['just', '--justfile', 'justfile', 'fleet-status'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_NODE: driverNode,
      FAKE_SSH_HRCDEV_NODE: overrides.hrcdev ?? 'hrcdev',
      FAKE_SSH_MAX3_NODE: overrides.max3 ?? 'max3',
      FAKE_SSH_MINI_NODE: overrides.mini ?? 'mini',
      FAKE_TRACE: tracePath,
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
    },
  })

  return {
    exitCode: child.exitCode,
    stderr: decoder.decode(child.stderr),
    stdout: decoder.decode(child.stdout),
    sshTargets: readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean),
  }
}

describe('T-09272 fleet-status driver selection', () => {
  test('from hrcdev, reaches max3 instead of relabelling the local hrcdev daemon', () => {
    const result = runFleetStatus('hrcdev')

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^max3\s+healthy\s+4136d813\s+d3e42545/m)
    expect(result.stdout).toMatch(/^hrcdev\s+healthy\s+6ee4ea67\s+da52b1ac/m)
    expect(result.sshTargets).toContain('max3')
  })

  test('from max3, retains the direct local max3 probe', () => {
    const result = runFleetStatus('max3')

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^max3\s+healthy\s+4136d813\s+d3e42545/m)
    expect(result.sshTargets).not.toContain('max3')
  })

  test('fails closed when a targeted probe returns a different node identity', () => {
    const result = runFleetStatus('hrcdev', { max3: 'hrcdev' })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^max3\s+wrong-driver:hrcdev\s+-/m)
  })
})
