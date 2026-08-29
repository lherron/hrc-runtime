import { wrkqAuthorityEnvironment } from '../federation/wrkq-authority.js'
import { writeServerLog } from '../server-log.js'
import type {
  WrkqEnvelope,
  WrkqEnvelopeBirth,
  WrkqEnvelopeBirthEnvelopeParams,
  WrkqEnvelopeFailParams,
  WrkqEnvelopePendingView,
  WrkqEnvelopePendingViewParams,
  WrkqEnvelopePresentParams,
  WrkqEnvelopePresentResult,
  WrkqEnvelopeShowParams,
  WrkqMonitorEvent,
  WrkqMonitorEventsView,
  WrkqMonitorEventsViewParams,
  WrkqRoomShowParams,
  WrkqRoomView,
} from './ledger-types.js'

/**
 * HRC's client for the wrkq collaboration ledger (T-07612 §10).
 *
 * Nothing in wrkq's surface is HRC's beyond these: `pendingView` (the kicker
 * wake set and the stop-hook predicate, whose read also sweeps due deferrals
 * back to pending), `present` (previews the §4 history-cue decision or writes
 * `presented_to` exactly-once per `driveAttemptId`, optionally joined to the
 * accepted broker input), `fail` (rev 5.1's unsuccessful terminal transition —
 * D3 lapse, D5 strike-out, D7 undeliverable), and `envelopeShow` (the §5 sender
 * notice's read-back, because the `envelope.failed` payload carries neither
 * party nor the room key).
 *
 * `roundEnded` is GONE with rev 5.1: an obligation's budget is no longer a
 * count of turn completions, so there is no round to end.
 *
 * TRANSPORT. One long-lived `wrkq rpc --stdio` child speaking newline-delimited
 * JSON-RPC, spawned under `wrkqAuthorityEnvironment()` — the daemon's existing
 * host-authoritative wrkq contract, already used by the task-claim client, so
 * the locator and node credential come from exactly one place.
 *
 * `rpc.initialize` is deliberately NOT sent. wrkqd serves these methods without
 * it, and the handshake is what pins a caller to a protocol schema hash: a
 * pinned hrc-server would refuse to reach a wrkqd on a different release and
 * take the daemon's mail path down on every wrkq deploy. HRC reads a small
 * structural subset of the DTOs (`ledger-types.ts`) and tolerates additive
 * change instead.
 *
 * UNAVAILABILITY IS TYPED. Every failure to reach wrkq surfaces as
 * `WrkqLedgerUnavailableError` so callers can choose: the stop-hook FAILS OPEN
 * on it (§8), while the kicker simply declines to drive.
 */

/** wrkq could not be reached, or did not answer in time. Never a ledger refusal. */
export class WrkqLedgerUnavailableError extends Error {
  constructor(
    message: string,
    readonly method: string
  ) {
    super(message)
    this.name = 'WrkqLedgerUnavailableError'
  }
}

/** wrkq answered, and the answer was an error frame. The ledger spoke; it said no. */
export class WrkqLedgerRequestError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'WrkqLedgerRequestError'
  }
}

export type WrkqLedgerClient = {
  pendingView(params: WrkqEnvelopePendingViewParams): Promise<WrkqEnvelopePendingView>
  /**
   * The BIRTH ENVELOPE of a target scope (T-07655): the lowest-seq
   * `reply_required` envelope ever addressed to it, in any state, or null.
   *
   * ONLY the registry HOST calls it. It is the one wrkq read that decides
   * placement, so it must have exactly one reader — a node re-deriving it
   * locally would be re-deciding a question the collective already answered.
   */
  birthEnvelope(params: WrkqEnvelopeBirthEnvelopeParams): Promise<WrkqEnvelopeBirth | null>
  present(params: WrkqEnvelopePresentParams): Promise<WrkqEnvelopePresentResult>
  /**
   * End one obligation unsuccessfully (rev 5.1 §2). Idempotent per
   * (envelope, runtime); a runtime that does not own the newest receipt is
   * REFUSED rather than allowed to fail someone else's presentation.
   */
  fail(params: WrkqEnvelopeFailParams): Promise<WrkqEnvelope>
  /** One envelope by id — the §5 failure notice's only source for its parties. */
  envelopeShow(params: WrkqEnvelopeShowParams): Promise<WrkqEnvelope>
  roomShow(params: WrkqRoomShowParams): Promise<WrkqRoomView>
  /** The bounded, cursor-fenced event page the kicker's wake tail reads. */
  eventsView(params: WrkqMonitorEventsViewParams): Promise<WrkqMonitorEventsView>
  close(): Promise<void>
}

export type WrkqLedgerClientOptions = {
  /** argv of the RPC child. Defaults to the installed `wrkq rpc --stdio`. */
  command?: readonly string[] | undefined
  env?: Record<string, string | undefined> | undefined
  /** Caller authority for every ledger write HRC makes. */
  principalRef?: string | undefined
  requestTimeoutMs?: number | undefined
}

/** HRC's caller authority on the ledger. The daemon presents; it never speaks as the agent. */
export const HRC_LEDGER_PRINCIPAL_REF = 'agent:hrc'

const DEFAULT_COMMAND = ['wrkq', 'rpc', '--stdio'] as const
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
/** A single ledger frame is a room's worth of bodies, never a transcript. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

type PendingCall = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Child = {
  process: ReturnType<typeof Bun.spawn>
  stdin: import('bun').FileSink
}

export class WrkqStdioLedgerClient implements WrkqLedgerClient {
  private child: Child | undefined
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private buffer = ''
  private closed = false
  private readonly command: readonly string[]
  private readonly principalRef: string
  private readonly requestTimeoutMs: number
  private readonly env: Record<string, string | undefined>

  constructor(options: WrkqLedgerClientOptions = {}) {
    this.command = options.command ?? DEFAULT_COMMAND
    this.principalRef = options.principalRef ?? HRC_LEDGER_PRINCIPAL_REF
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.env = { ...process.env, ...wrkqAuthorityEnvironment(), ...(options.env ?? {}) }
  }

  pendingView(params: WrkqEnvelopePendingViewParams): Promise<WrkqEnvelopePendingView> {
    return this.call<WrkqEnvelopePendingView>('wrkq.envelope.pendingView', params)
  }

  birthEnvelope(params: WrkqEnvelopeBirthEnvelopeParams): Promise<WrkqEnvelopeBirth | null> {
    return this.call<WrkqEnvelopeBirth | null>('wrkq.envelope.birthEnvelope', params)
  }

  present(params: WrkqEnvelopePresentParams): Promise<WrkqEnvelopePresentResult> {
    return this.call<WrkqEnvelopePresentResult>('wrkq.envelope.present', params)
  }

  fail(params: WrkqEnvelopeFailParams): Promise<WrkqEnvelope> {
    return this.call<WrkqEnvelope>('wrkq.envelope.fail', params)
  }

  envelopeShow(params: WrkqEnvelopeShowParams): Promise<WrkqEnvelope> {
    return this.call<WrkqEnvelope>('wrkq.envelope.show', params)
  }

  roomShow(params: WrkqRoomShowParams): Promise<WrkqRoomView> {
    return this.call<WrkqRoomView>('wrkq.room.show', params)
  }

  async eventsView(params: WrkqMonitorEventsViewParams): Promise<WrkqMonitorEventsView> {
    const view = await this.call<{ items?: unknown; high_water?: unknown }>(
      'wrkq.monitor.eventsView',
      params
    )
    return {
      items: Array.isArray(view.items) ? view.items.map(mapMonitorEvent) : [],
      highWater: typeof view.high_water === 'number' ? view.high_water : params.cursor,
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.teardown(new WrkqLedgerUnavailableError('wrkq ledger client closed', 'close'))
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) {
      throw new WrkqLedgerUnavailableError('wrkq ledger client is closed', method)
    }
    const child = this.ensureChild(method)
    const id = this.nextId
    this.nextId += 1
    const frame = `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      // T-07647: wrkqd names every undeclared param in its log and will refuse
      // them again after the consumer audit. pendingView, present, fail,
      // envelope.show and room.show DECLARE principalRef and require it for
      // attribution; eventsView and birthEnvelope do not, so those two must
      // not carry it.
      params: PRINCIPAL_FREE_METHODS.has(method)
        ? params
        : { principalRef: this.principalRef, ...params },
    })}\n`

    const settled = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A wedged child cannot be reasoned about: every later call would
        // inherit the stall. Drop it so the next call gets a fresh one.
        this.teardown(
          new WrkqLedgerUnavailableError(
            `wrkq ${method} did not answer within ${this.requestTimeoutMs}ms`,
            method
          )
        )
        reject(
          new WrkqLedgerUnavailableError(
            `wrkq ${method} did not answer within ${this.requestTimeoutMs}ms`,
            method
          )
        )
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
    })

    try {
      child.stdin.write(frame)
      await child.stdin.flush()
    } catch (error) {
      const failure = new WrkqLedgerUnavailableError(
        `failed to write to the wrkq ledger transport: ${errorText(error)}`,
        method
      )
      this.teardown(failure)
      throw failure
    }
    return settled
  }

  private ensureChild(method: string): Child {
    if (this.child !== undefined) return this.child
    let spawned: ReturnType<typeof Bun.spawn>
    try {
      spawned = Bun.spawn([...this.command], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: this.env,
      })
    } catch (error) {
      throw new WrkqLedgerUnavailableError(
        `failed to spawn ${this.command.join(' ')}: ${errorText(error)}`,
        method
      )
    }
    const child: Child = { process: spawned, stdin: spawned.stdin as import('bun').FileSink }
    this.child = child
    this.buffer = ''
    void this.pump(child)
    void spawned.exited.then((code) => {
      if (this.child !== child) return
      this.teardown(
        new WrkqLedgerUnavailableError(`the wrkq ledger transport exited with code ${code}`, method)
      )
    })
    return child
  }

  private async pump(child: Child): Promise<void> {
    try {
      for await (const chunk of child.process.stdout as ReadableStream<Uint8Array>) {
        if (this.child !== child) return
        this.buffer += new TextDecoder().decode(chunk)
        if (this.buffer.length > MAX_FRAME_BYTES) {
          this.teardown(
            new WrkqLedgerUnavailableError(
              'the wrkq ledger transport emitted an oversized frame',
              'stdout'
            )
          )
          return
        }
        let newline = this.buffer.indexOf('\n')
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline).trim()
          this.buffer = this.buffer.slice(newline + 1)
          if (line.length > 0) this.dispatch(line)
          newline = this.buffer.indexOf('\n')
        }
      }
    } catch (error) {
      if (this.child !== child) return
      this.teardown(
        new WrkqLedgerUnavailableError(
          `the wrkq ledger transport failed: ${errorText(error)}`,
          'stdout'
        )
      )
    }
  }

  private dispatch(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      writeServerLog('WARN', 'wrkq.ledger.unparseable_frame', { bytes: line.length })
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const record = frame as Record<string, unknown>
    const id = record['id']
    if (typeof id !== 'number') return
    const call = this.pending.get(id)
    if (call === undefined) return
    this.pending.delete(id)
    clearTimeout(call.timer)

    const error = record['error']
    if (typeof error === 'object' && error !== null) {
      const detail = error as Record<string, unknown>
      const message =
        typeof detail['message'] === 'string' ? detail['message'] : 'wrkq rejected the request'
      if (isStaleSessionError(message)) {
        // Observed live when the canonical wrkqd restarted underneath us: the
        // transport reconnects but its remote session is gone, and every later
        // call on this child inherits the fault. It is a TRANSPORT problem
        // wearing an error frame, so the child is dropped and the next call
        // gets a fresh one -- one failed tick instead of a permanent wedge.
        const stale = new WrkqLedgerUnavailableError(
          `the wrkq ledger transport lost its session: ${message}`,
          call.method
        )
        call.reject(stale)
        this.teardown(stale)
        return
      }
      call.reject(
        new WrkqLedgerRequestError(
          message,
          call.method,
          typeof detail['code'] === 'number' ? detail['code'] : 0,
          detail['data']
        )
      )
      return
    }
    call.resolve(record['result'])
  }

  private teardown(reason: Error): void {
    const child = this.child
    this.child = undefined
    this.buffer = ''
    for (const [id, call] of this.pending) {
      this.pending.delete(id)
      clearTimeout(call.timer)
      call.reject(reason)
    }
    if (child === undefined) return
    try {
      void child.stdin.end()
    } catch {
      // The writer is already closed; killing the process is what matters.
    }
    try {
      child.process.kill()
    } catch {
      // Already gone.
    }
  }
}

/**
 * The event view is the one wrkq DTO on this seam with snake_case wire fields
 * (it is the server projection of the legacy NDJSON monitor line), so it is
 * mapped here rather than leaking two naming conventions into the tail.
 */
function mapMonitorEvent(raw: unknown): WrkqMonitorEvent {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    id: typeof row['id'] === 'number' ? row['id'] : 0,
    timestamp: typeof row['timestamp'] === 'string' ? row['timestamp'] : '',
    resourceType: typeof row['resource_type'] === 'string' ? row['resource_type'] : '',
    ...(typeof row['resource_uuid'] === 'string' ? { resourceUuid: row['resource_uuid'] } : {}),
    ...(typeof row['resource_id'] === 'string' ? { resourceId: row['resource_id'] } : {}),
    eventType: typeof row['event_type'] === 'string' ? row['event_type'] : '',
    ...(typeof row['payload'] === 'string' ? { payload: row['payload'] } : {}),
  }
}

/**
 * Does this error frame mean "your session is gone", rather than "no"?
 *
 * The distinction matters because only the first is worth dropping the child
 * over. Matching on the message is unlovely, but the alternative — sending
 * `rpc.initialize` on every child — is the protocol-schema pin this client
 * exists to avoid.
 */
/** wrkqd params structs that do not declare principalRef (T-07647 audit). */
const PRINCIPAL_FREE_METHODS = new Set(['wrkq.monitor.eventsView', 'wrkq.envelope.birthEnvelope'])

function isStaleSessionError(message: string): boolean {
  return /rpc\.initialize/i.test(message) || /transport failure/i.test(message)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
