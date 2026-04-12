/**
 * RED/GREEN TDD tests for HRC path resolution (T-00949)
 *
 * Spec reference: HRC_IMPLEMENTATION_PLAN.md § Runtime directories
 *
 * Path resolution precedence:
 *
 * runtimeRoot:
 *   1. HRC_RUNTIME_DIR if set
 *   2. ~/praesidium/var/run/hrc when HOME exists
 *   3. ${XDG_RUNTIME_DIR}/hrc when XDG_RUNTIME_DIR exists
 *   4. ${TMPDIR}/hrc-${UID} (fallback, TMPDIR defaults to /tmp)
 *
 * stateRoot:
 *   1. HRC_STATE_DIR if set
 *   2. ~/praesidium/var/state/hrc when HOME exists
 *   3. ${XDG_STATE_HOME}/hrc when HOME is unavailable
 *   4. otherwise throw
 *
 * Within roots:
 *   - control socket: <runtimeRoot>/hrc.sock
 *   - tmux socket: <runtimeRoot>/tmux.sock
 *   - launch artifacts: <runtimeRoot>/launches/
 *   - spool dir: <runtimeRoot>/spool/
 *   - sqlite db: <stateRoot>/state.sqlite
 *   - migration marker dir: <stateRoot>/migrations/
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  resolveControlSocketPath,
  resolveDatabasePath,
  resolveLaunchesDir,
  resolveMigrationsDir,
  resolveRuntimeRoot,
  resolveSpoolDir,
  resolveStateRoot,
  resolveTmuxSocketPath,
} from '../paths.js'

// ===================================================================
// Helpers — save/restore env
// ===================================================================

const ENV_KEYS = [
  'HRC_RUNTIME_DIR',
  'HRC_STATE_DIR',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
  'TMPDIR',
  'HOME',
] as const

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = savedEnv[k]
    }
  }
})

// ===================================================================
// runtimeRoot resolution
// ===================================================================

describe('resolveRuntimeRoot (T-00949)', () => {
  test('prefers HRC_RUNTIME_DIR when set', () => {
    process.env.HRC_RUNTIME_DIR = '/custom/runtime'
    process.env.HOME = '/home/testuser'
    process.env.XDG_RUNTIME_DIR = '/xdg/runtime'
    expect(resolveRuntimeRoot()).toBe('/custom/runtime')
  })

  test('falls back to HOME/praesidium/var/run/hrc when HRC_RUNTIME_DIR is unset', () => {
    process.env.HRC_RUNTIME_DIR = undefined
    process.env.HOME = '/home/testuser'
    process.env.XDG_RUNTIME_DIR = '/xdg/runtime'
    expect(resolveRuntimeRoot()).toBe('/home/testuser/praesidium/var/run/hrc')
  })

  test('falls back to XDG_RUNTIME_DIR/hrc when HOME is unset', () => {
    process.env.HRC_RUNTIME_DIR = undefined
    process.env.HOME = undefined
    process.env.XDG_RUNTIME_DIR = '/xdg/runtime'
    expect(resolveRuntimeRoot()).toBe('/xdg/runtime/hrc')
  })

  test('falls back to TMPDIR/hrc-UID when HRC_RUNTIME_DIR, HOME, and XDG_RUNTIME_DIR are unset', () => {
    process.env.HRC_RUNTIME_DIR = undefined
    process.env.HOME = undefined
    process.env.XDG_RUNTIME_DIR = undefined
    process.env.TMPDIR = '/my/tmp'
    const result = resolveRuntimeRoot()
    // Should match /my/tmp/hrc-<uid>
    expect(result).toMatch(/^\/my\/tmp\/hrc-\d+$/)
  })

  test('uses /tmp as TMPDIR fallback', () => {
    process.env.HRC_RUNTIME_DIR = undefined
    process.env.HOME = undefined
    process.env.XDG_RUNTIME_DIR = undefined
    process.env.TMPDIR = undefined
    const result = resolveRuntimeRoot()
    expect(result).toMatch(/^\/tmp\/hrc-\d+$/)
  })

  test('ignores empty HRC_RUNTIME_DIR', () => {
    process.env.HRC_RUNTIME_DIR = ''
    process.env.HOME = '/home/testuser'
    process.env.XDG_RUNTIME_DIR = '/xdg/runtime'
    expect(resolveRuntimeRoot()).toBe('/home/testuser/praesidium/var/run/hrc')
  })

  test('ignores empty XDG_RUNTIME_DIR', () => {
    process.env.HRC_RUNTIME_DIR = undefined
    process.env.HOME = undefined
    process.env.XDG_RUNTIME_DIR = ''
    process.env.TMPDIR = '/my/tmp'
    const result = resolveRuntimeRoot()
    expect(result).toMatch(/^\/my\/tmp\/hrc-\d+$/)
  })
})

// ===================================================================
// stateRoot resolution
// ===================================================================

describe('resolveStateRoot (T-00949)', () => {
  test('prefers HRC_STATE_DIR when set', () => {
    process.env.HRC_STATE_DIR = '/custom/state'
    process.env.HOME = '/home/testuser'
    process.env.XDG_STATE_HOME = '/xdg/state'
    expect(resolveStateRoot()).toBe('/custom/state')
  })

  test('falls back to HOME/praesidium/var/state/hrc when HRC_STATE_DIR is unset', () => {
    process.env.HRC_STATE_DIR = undefined
    process.env.HOME = '/home/testuser'
    process.env.XDG_STATE_HOME = '/xdg/state'
    expect(resolveStateRoot()).toBe('/home/testuser/praesidium/var/state/hrc')
  })

  test('falls back to XDG_STATE_HOME/hrc when HOME is unset', () => {
    process.env.HRC_STATE_DIR = undefined
    process.env.HOME = undefined
    process.env.XDG_STATE_HOME = '/xdg/state'
    expect(resolveStateRoot()).toBe('/xdg/state/hrc')
  })

  test('throws when HRC_STATE_DIR, HOME, and XDG_STATE_HOME are all unavailable', () => {
    process.env.HRC_STATE_DIR = undefined
    process.env.HOME = undefined
    process.env.XDG_STATE_HOME = undefined
    expect(() => resolveStateRoot()).toThrow(
      'Cannot resolve HRC state directory: set HRC_STATE_DIR, HOME, or XDG_STATE_HOME'
    )
  })

  test('ignores empty HRC_STATE_DIR', () => {
    process.env.HRC_STATE_DIR = ''
    process.env.HOME = '/home/testuser'
    process.env.XDG_STATE_HOME = '/xdg/state'
    expect(resolveStateRoot()).toBe('/home/testuser/praesidium/var/state/hrc')
  })
})

// ===================================================================
// Derived paths within roots
// ===================================================================

describe('Derived paths from runtimeRoot (T-00949)', () => {
  test('control socket is runtimeRoot/hrc.sock', () => {
    process.env.HRC_RUNTIME_DIR = '/run/hrc'
    expect(resolveControlSocketPath()).toBe('/run/hrc/hrc.sock')
  })

  test('tmux socket is runtimeRoot/tmux.sock', () => {
    process.env.HRC_RUNTIME_DIR = '/run/hrc'
    expect(resolveTmuxSocketPath()).toBe('/run/hrc/tmux.sock')
  })

  test('launches dir is runtimeRoot/launches/', () => {
    process.env.HRC_RUNTIME_DIR = '/run/hrc'
    expect(resolveLaunchesDir()).toBe('/run/hrc/launches')
  })

  test('spool dir is runtimeRoot/spool/', () => {
    process.env.HRC_RUNTIME_DIR = '/run/hrc'
    expect(resolveSpoolDir()).toBe('/run/hrc/spool')
  })
})

describe('Derived paths from stateRoot (T-00949)', () => {
  test('database is stateRoot/state.sqlite', () => {
    process.env.HRC_STATE_DIR = '/state/hrc'
    expect(resolveDatabasePath()).toBe('/state/hrc/state.sqlite')
  })

  test('migrations dir is stateRoot/migrations/', () => {
    process.env.HRC_STATE_DIR = '/state/hrc'
    expect(resolveMigrationsDir()).toBe('/state/hrc/migrations')
  })
})
