import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import {
  isLifecycleCredentialRuntimeId,
  lifecycleCredentialDirectory,
  lifecycleCredentialPath,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { constantTimeEqual } from './constant-time.js'
import { writeServerLog } from './server-log.js'

/**
 * T-09861 §3 — the daemon-minted lifecycle credential.
 *
 * One random 256-bit value per live agent runtime, bound to
 * (runtimeId, scopeRef, generation), held ONLY in this daemon's memory and
 * delivered to the seat as a 0600 file at
 * `<runtime root>/lifecycle/<runtimeId>.credential`. Nothing goes into the
 * launch env, so `env` dumps and `ps eww` expose a path, never the secret.
 *
 * Because the value lives in memory, a daemon accepts only credentials it
 * minted in this incarnation: every boot re-mints and rewrites every live
 * runtime's file (the backfill), so a value from a predecessor, another node,
 * or a terminated runtime cannot match. The file is delivery, never authority:
 * verification re-reads liveness from the store on every request.
 */

/** The same live predicate as `RuntimeRepository.listLiveSessionRefs`. */
export const LIFECYCLE_LIVE_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  'starting',
  'ready',
  'busy',
  'awaiting_input',
  'stopping',
])

export type LifecycleCredentialBinding = {
  readonly runtimeId: string
  readonly scopeRef: string
  readonly generation: number
  readonly mintedAt: string
}

/** A binding is valid only while its runtime is live with the bound scope and generation. */
export function isLifecycleBindingLive(
  db: HrcDatabase,
  binding: LifecycleCredentialBinding
): boolean {
  const runtime = db.runtimes.getByRuntimeId(binding.runtimeId)
  return (
    runtime !== null &&
    LIFECYCLE_LIVE_RUNTIME_STATUSES.has(runtime.status) &&
    runtime.scopeRef === binding.scopeRef &&
    runtime.generation === binding.generation
  )
}

type HeldCredential = LifecycleCredentialBinding & { readonly value: string }

function isEligible(runtime: HrcRuntimeSnapshot): boolean {
  return (
    LIFECYCLE_LIVE_RUNTIME_STATUSES.has(runtime.status) &&
    runtime.scopeRef.startsWith('agent:') &&
    isLifecycleCredentialRuntimeId(runtime.runtimeId)
  )
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export class LifecycleCredentialStore {
  readonly #held = new Map<string, HeldCredential>()
  readonly #directory: string

  constructor(private readonly runtimeRoot: string) {
    this.#directory = lifecycleCredentialDirectory(runtimeRoot)
  }

  /**
   * Store observer: mint on a live agent runtime that has none (or whose
   * binding moved), revoke on anything else.
   */
  observe(runtime: HrcRuntimeSnapshot): void {
    if (!isEligible(runtime)) {
      this.revoke(runtime.runtimeId, 'not_live')
      return
    }
    const held = this.#held.get(runtime.runtimeId)
    if (
      held !== undefined &&
      held.scopeRef === runtime.scopeRef &&
      held.generation === runtime.generation
    ) {
      return
    }
    this.mint(runtime)
  }

  /**
   * Boot backfill and periodic sweep. At boot the map is empty, so every live
   * runtime gets a fresh value and its file is rewritten; files for anything
   * not live are removed.
   */
  reconcile(liveRuntimes: readonly HrcRuntimeSnapshot[]): void {
    const live = new Map<string, HrcRuntimeSnapshot>()
    for (const runtime of liveRuntimes) {
      if (isEligible(runtime)) live.set(runtime.runtimeId, runtime)
    }
    for (const runtimeId of [...this.#held.keys()]) {
      if (!live.has(runtimeId)) this.revoke(runtimeId, 'reconcile_not_live')
    }
    for (const runtime of live.values()) this.observe(runtime)

    let entries: string[]
    try {
      entries = readdirSync(this.#directory)
    } catch (error) {
      if (!isEnoent(error)) {
        writeServerLog('WARN', 'server.lifecycle.credential_sweep_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    for (const entry of entries) {
      const runtimeId = entry.endsWith('.credential') ? entry.slice(0, -'.credential'.length) : ''
      if (runtimeId.length > 0 && this.#held.has(runtimeId)) continue
      try {
        unlinkSync(join(this.#directory, entry))
      } catch {
        // Best effort: an orphan file grants nothing without a held value.
      }
    }
  }

  /** The binding for a presented (runtimeId, value), or undefined. Constant-time on the value. */
  verify(runtimeId: string, value: string): LifecycleCredentialBinding | undefined {
    const held = this.#held.get(runtimeId)
    if (held === undefined) return undefined
    if (!constantTimeEqual(held.value, value)) return undefined
    return {
      runtimeId: held.runtimeId,
      scopeRef: held.scopeRef,
      generation: held.generation,
      mintedAt: held.mintedAt,
    }
  }

  revoke(runtimeId: string, reason: string): void {
    const had = this.#held.delete(runtimeId)
    if (!isLifecycleCredentialRuntimeId(runtimeId)) return
    try {
      unlinkSync(lifecycleCredentialPath(this.runtimeRoot, runtimeId))
    } catch (error) {
      if (!isEnoent(error)) {
        writeServerLog('WARN', 'server.lifecycle.credential_unlink_failed', {
          runtimeId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    if (had) writeServerLog('INFO', 'server.lifecycle.credential_revoked', { runtimeId, reason })
  }

  heldCount(): number {
    return this.#held.size
  }

  private mint(runtime: HrcRuntimeSnapshot): void {
    const credential: HeldCredential = {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      generation: runtime.generation,
      mintedAt: new Date().toISOString(),
      value: randomBytes(32).toString('hex'),
    }
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 })
      chmodSync(this.#directory, 0o700)
      const destination = lifecycleCredentialPath(this.runtimeRoot, runtime.runtimeId)
      const temporary = join(
        this.#directory,
        `.${runtime.runtimeId}.${process.pid}.${randomUUID()}.tmp`
      )
      writeFileSync(temporary, `${credential.value}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, destination)
    } catch (error) {
      // Without a delivered file the seat simply has no credential and is
      // refused; never hold a value nobody can present.
      this.#held.delete(runtime.runtimeId)
      writeServerLog('WARN', 'server.lifecycle.credential_mint_failed', {
        runtimeId: runtime.runtimeId,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    this.#held.set(runtime.runtimeId, credential)
  }
}
