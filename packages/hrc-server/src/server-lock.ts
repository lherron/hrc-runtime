import { mkdir, open, readFile } from 'node:fs/promises'
import { Socket } from 'node:net'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { HrcServerOptions } from './server-types.js'
import { timestamp, unlinkIfExists } from './server-util.js'

const STALE_LOCK_RETRY_DELAY_MS = 25
const SOCKET_PROBE_TIMEOUT_MS = 200

export type ServerLockOwner = {
  pid: number
  createdAt: string
}

export type ServerLockHandle = {
  owner: ServerLockOwner
}

type ServerLockState = {
  owner: ServerLockOwner | null
  raw: string
}

export async function prepareFilesystem(
  options: HrcServerOptions,
  tmuxSocketPath: string
): Promise<void> {
  await Promise.all([
    mkdir(options.runtimeRoot, { recursive: true }),
    mkdir(options.stateRoot, { recursive: true }),
    mkdir(options.spoolDir, { recursive: true }),
    mkdir(dirname(options.socketPath), { recursive: true }),
    mkdir(dirname(options.lockPath), { recursive: true }),
    mkdir(dirname(options.dbPath), { recursive: true }),
    mkdir(dirname(tmuxSocketPath), { recursive: true }),
  ])
}

export async function acquireServerLock(options: HrcServerOptions): Promise<ServerLockHandle> {
  while (true) {
    const owner = createServerLockOwner()
    const raw = serializeServerLockOwner(owner)
    if (await tryWriteExclusiveFile(options.lockPath, raw)) {
      return { owner }
    }

    const existingLock = await readServerLock(options.lockPath)
    if (existingLock === null) {
      continue
    }

    if (existingLock.owner === null) {
      throw new Error(`hrc server lock ${options.lockPath} is malformed; manual cleanup required`)
    }

    if (isLiveProcess(existingLock.owner.pid)) {
      throw createServerAlreadyRunningError(options.lockPath, existingLock.owner)
    }

    if (await isUnixSocketResponsive(options.socketPath)) {
      throw createServerAlreadyRunningError(options.lockPath, existingLock.owner)
    }

    await clearStaleServerState(options, existingLock)
  }
}

export function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (getErrorCode(error) === 'ESRCH') {
      return false
    }

    if (getErrorCode(error) === 'EPERM') {
      return true
    }

    throw error
  }
}

export async function cleanupFailedStartup(
  options: HrcServerOptions,
  lockHandle: ServerLockHandle,
  shouldCleanupSocket: boolean
): Promise<void> {
  if (shouldCleanupSocket) {
    await unlinkIfExists(options.socketPath).catch(() => undefined)
  }

  await releaseServerLock(options.lockPath, lockHandle).catch(() => undefined)
}

export async function prepareSocketForStartup(socketPath: string): Promise<void> {
  if (await isUnixSocketResponsive(socketPath)) {
    throw new Error(`hrc server socket ${socketPath} is already active`)
  }

  await unlinkIfExists(socketPath)
}

async function clearStaleServerState(
  options: HrcServerOptions,
  expectedLock: ServerLockState
): Promise<void> {
  const cleanupHandle = await acquireCleanupClaim(options.lockPath)

  try {
    const currentLock = await readServerLock(options.lockPath)
    if (currentLock === null || currentLock.raw !== expectedLock.raw) {
      return
    }

    if (currentLock.owner === null) {
      throw new Error(`hrc server lock ${options.lockPath} is malformed; manual cleanup required`)
    }

    if (isLiveProcess(currentLock.owner.pid)) {
      throw createServerAlreadyRunningError(options.lockPath, currentLock.owner)
    }

    if (await isUnixSocketResponsive(options.socketPath)) {
      throw createServerAlreadyRunningError(options.lockPath, currentLock.owner)
    }

    await unlinkIfExists(options.socketPath)
    await unlinkIfExists(options.lockPath)
  } finally {
    await releaseServerLock(getCleanupClaimPath(options.lockPath), cleanupHandle).catch(
      () => undefined
    )
  }
}

async function acquireCleanupClaim(lockPath: string): Promise<ServerLockHandle> {
  const cleanupPath = getCleanupClaimPath(lockPath)

  while (true) {
    const owner = createServerLockOwner()
    if (await tryWriteExclusiveFile(cleanupPath, serializeServerLockOwner(owner))) {
      return { owner }
    }

    const existingClaim = await readServerLock(cleanupPath)
    if (existingClaim?.owner && isLiveProcess(existingClaim.owner.pid)) {
      await delay(STALE_LOCK_RETRY_DELAY_MS)
      continue
    }

    await unlinkIfExists(cleanupPath)
  }
}

function getCleanupClaimPath(lockPath: string): string {
  return `${lockPath}.cleanup`
}

export async function releaseServerLock(
  lockPath: string,
  lockHandle: ServerLockHandle
): Promise<void> {
  const currentLock = await readServerLock(lockPath)
  if (currentLock === null || currentLock.owner === null) {
    return
  }

  if (!isSameLockOwner(currentLock.owner, lockHandle.owner)) {
    return
  }

  await unlinkIfExists(lockPath)
}

async function tryWriteExclusiveFile(path: string, content: string): Promise<boolean> {
  const handle = await open(path, 'wx').catch((error) => {
    if (getErrorCode(error) === 'EEXIST') {
      return null
    }

    throw error
  })
  if (handle === null) {
    return false
  }

  try {
    await handle.writeFile(content, 'utf-8')
    return true
  } catch (error) {
    await unlinkIfExists(path).catch(() => undefined)
    throw error
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readServerLock(lockPath: string): Promise<ServerLockState | null> {
  try {
    const raw = await readFile(lockPath, 'utf-8')
    return {
      owner: parseServerLockOwner(raw),
      raw,
    }
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null
    }

    throw error
  }
}

function createServerLockOwner(): ServerLockOwner {
  return {
    pid: process.pid,
    createdAt: timestamp(),
  }
}

function serializeServerLockOwner(owner: ServerLockOwner): string {
  return `${JSON.stringify(owner)}\n`
}

function parseServerLockOwner(raw: string): ServerLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServerLockOwner> | number
    if (typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0) {
      return {
        pid: parsed,
        createdAt: 'unknown',
      }
    }

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === 'string' &&
      parsed.createdAt.length > 0
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      }
    }
  } catch {
    const pid = Number.parseInt(raw.trim(), 10)
    if (Number.isInteger(pid) && pid > 0) {
      return {
        pid,
        createdAt: 'unknown',
      }
    }
  }

  return null
}

function isSameLockOwner(left: ServerLockOwner, right: ServerLockOwner): boolean {
  return left.pid === right.pid && left.createdAt === right.createdAt
}

function createServerAlreadyRunningError(lockPath: string, owner: ServerLockOwner): Error {
  return new Error(
    `hrc server already running with lock ${lockPath} (pid ${owner.pid}, createdAt ${owner.createdAt})`
  )
}

async function isUnixSocketResponsive(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false
    const socket = new Socket()
    const finish = (responsive: boolean): void => {
      if (settled) {
        return
      }

      settled = true
      socket.destroy()
      resolve(responsive)
    }

    socket.once('connect', () => finish(true))
    socket.once('error', (error) => {
      const code = getErrorCode(error)
      finish(code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ENOTSOCK')
    })
    socket.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => finish(true))
    try {
      socket.connect(socketPath)
    } catch (error) {
      const code = getErrorCode(error)
      finish(code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ENOTSOCK')
    }
  })
}

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code?: unknown }
    return typeof code === 'string' ? code : undefined
  }

  return undefined
}
