import type { HrcEventEnvelope, HrcLifecycleEvent } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { GhostmuxManager as ServerGhostmuxManager } from './ghostmux.js'
import type { TmuxManager as ServerTmuxManager } from './tmux.js'

/**
 * Shared dependencies + callbacks that decomposed `HrcServerInstance` handler
 * modules need. The class builds a single `ServerContext` in its constructor and
 * passes it to extracted `(ctx, ...args)` functions, so handlers can read the
 * server's collaborators without holding a reference to `this`.
 *
 * Grow this surface one cluster at a time as method clusters are extracted —
 * keep it to genuinely-shared deps, not per-handler conveniences.
 */
export interface ServerContext {
  readonly db: HrcDatabase
  readonly tmux: ServerTmuxManager
  readonly ghostmux: ServerGhostmuxManager
  notifyEvent(event: HrcEventEnvelope | HrcLifecycleEvent): void
}
