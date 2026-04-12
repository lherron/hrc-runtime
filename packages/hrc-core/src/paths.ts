import { join } from 'node:path'

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  if (typeof value !== 'string') return undefined

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function resolveUid(): number {
  if (typeof process.getuid === 'function') {
    return process.getuid()
  }
  return 0
}

function resolvePraesidiumVarRoot(): string | undefined {
  const homeDir = readEnv('HOME')
  if (homeDir === undefined) {
    return undefined
  }
  return join(homeDir, 'praesidium', 'var')
}

export function resolveRuntimeRoot(): string {
  const explicitRuntimeRoot = readEnv('HRC_RUNTIME_DIR')
  if (explicitRuntimeRoot !== undefined) {
    return explicitRuntimeRoot
  }

  const praesidiumVarRoot = resolvePraesidiumVarRoot()
  if (praesidiumVarRoot !== undefined) {
    return join(praesidiumVarRoot, 'run', 'hrc')
  }

  const xdgRuntimeDir = readEnv('XDG_RUNTIME_DIR')
  if (xdgRuntimeDir !== undefined) {
    return join(xdgRuntimeDir, 'hrc')
  }

  const tmpDir = readEnv('TMPDIR') ?? '/tmp'
  return join(tmpDir, `hrc-${resolveUid()}`)
}

export function resolveStateRoot(): string {
  const explicitStateRoot = readEnv('HRC_STATE_DIR')
  if (explicitStateRoot !== undefined) {
    return explicitStateRoot
  }

  const praesidiumVarRoot = resolvePraesidiumVarRoot()
  if (praesidiumVarRoot !== undefined) {
    return join(praesidiumVarRoot, 'state', 'hrc')
  }

  const xdgStateHome = readEnv('XDG_STATE_HOME')
  if (xdgStateHome !== undefined) {
    return join(xdgStateHome, 'hrc')
  }
  throw new Error('Cannot resolve HRC state directory: set HRC_STATE_DIR, HOME, or XDG_STATE_HOME')
}

export function resolveControlSocketPath(): string {
  return join(resolveRuntimeRoot(), 'hrc.sock')
}

export function resolveTmuxSocketPath(): string {
  return join(resolveRuntimeRoot(), 'tmux.sock')
}

export function resolveLaunchesDir(): string {
  return join(resolveRuntimeRoot(), 'launches')
}

export function resolveSpoolDir(): string {
  return join(resolveRuntimeRoot(), 'spool')
}

export function resolveDatabasePath(): string {
  return join(resolveStateRoot(), 'state.sqlite')
}

export function resolveMigrationsDir(): string {
  return join(resolveStateRoot(), 'migrations')
}
