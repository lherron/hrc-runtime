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

export function resolveRuntimeRoot(): string {
  const explicitRuntimeRoot = readEnv('HRC_RUNTIME_DIR')
  if (explicitRuntimeRoot !== undefined) {
    return explicitRuntimeRoot
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

  const xdgStateHome = readEnv('XDG_STATE_HOME')
  if (xdgStateHome !== undefined) {
    return join(xdgStateHome, 'hrc')
  }

  const homeDir = readEnv('HOME')
  if (homeDir === undefined) {
    throw new Error('Cannot resolve HRC state directory: HOME environment variable is not set')
  }
  return join(homeDir, '.local', 'state', 'hrc')
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
