/**
 * Per-daemon, per-scope reader/writer serialization shared by summon/mint
 * paths and manual rebind steps. Summons remain concurrent with one another,
 * while a rebind step is exclusive and cannot pass an in-flight summon
 * between its authority check and session mint.
 */

type LockKind = 'summon' | 'rebind'

interface LockWaiter {
  kind: LockKind
  ready: () => void
}

interface ScopeAuthorityLock {
  readers: number
  writer: boolean
  queue: LockWaiter[]
}

const ownerLocks = new WeakMap<object, Map<string, ScopeAuthorityLock>>()
const ownerSessionMintTails = new WeakMap<object, Map<string, Promise<void>>>()

function acquire(lock: ScopeAuthorityLock, kind: LockKind): Promise<void> {
  const writerQueued = lock.queue.some((waiter) => waiter.kind === 'rebind')
  if (kind === 'summon' && !lock.writer && !writerQueued) {
    lock.readers += 1
    return Promise.resolve()
  }
  if (kind === 'rebind' && !lock.writer && lock.readers === 0 && lock.queue.length === 0) {
    lock.writer = true
    return Promise.resolve()
  }
  return new Promise((ready) => lock.queue.push({ kind, ready }))
}

function drain(lock: ScopeAuthorityLock): void {
  if (lock.writer || lock.readers > 0 || lock.queue.length === 0) return

  if (lock.queue[0]?.kind === 'rebind') {
    const waiter = lock.queue.shift()
    if (waiter === undefined) return
    lock.writer = true
    waiter.ready()
    return
  }

  while (lock.queue[0]?.kind === 'summon') {
    const waiter = lock.queue.shift()
    if (waiter === undefined) return
    lock.readers += 1
    waiter.ready()
  }
}

async function withLock<T>(
  owner: object,
  scopeRef: string,
  kind: LockKind,
  operation: () => T | Promise<T>
): Promise<T> {
  let locks = ownerLocks.get(owner)
  if (locks === undefined) {
    locks = new Map()
    ownerLocks.set(owner, locks)
  }
  let lock = locks.get(scopeRef)
  if (lock === undefined) {
    lock = { readers: 0, writer: false, queue: [] }
    locks.set(scopeRef, lock)
  }

  await acquire(lock, kind)
  try {
    return await operation()
  } finally {
    if (kind === 'summon') lock.readers -= 1
    else lock.writer = false
    drain(lock)
    if (!lock.writer && lock.readers === 0 && lock.queue.length === 0) locks.delete(scopeRef)
  }
}

export async function withScopeSummonLock<T>(
  owner: object,
  scopeRef: string,
  operation: () => T | Promise<T>
): Promise<T> {
  return await withLock(owner, scopeRef, 'summon', operation)
}

export async function withScopeAuthorityLock<T>(
  owner: object,
  scopeRef: string,
  operation: () => T | Promise<T>
): Promise<T> {
  return await withLock(owner, scopeRef, 'rebind', operation)
}

/**
 * Exclusive per-scope/lane mint serialization nested inside a summon reader.
 *
 * Summons for different lanes remain concurrent and rebind still waits for all
 * summon readers. The mint callback must re-read continuity after entering.
 */
export async function withSessionMintLock<T>(
  owner: object,
  scopeRef: string,
  laneRef: string,
  operation: () => T | Promise<T>
): Promise<T> {
  let tails = ownerSessionMintTails.get(owner)
  if (tails === undefined) {
    tails = new Map()
    ownerSessionMintTails.set(owner, tails)
  }
  const key = `${scopeRef}\u0000${laneRef}`
  const prior = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  tails.set(key, tail)

  await prior
  try {
    return await operation()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}
