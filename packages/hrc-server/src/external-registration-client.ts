import { createConnection } from 'node:net'
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  type ExternalParticipantClientFactory,
  type ExternalParticipantNotification,
  type ExternalParticipantRpcClient,
  MAX_EXTERNAL_PARTICIPANT_BUFFERED_NOTIFICATIONS,
  MAX_EXTERNAL_PARTICIPANT_NDJSON_LINE_BYTES,
  isRecord,
} from './external-registration-protocol.js'

class ExternalParticipantNotificationQueue
  implements AsyncIterable<ExternalParticipantNotification>
{
  private readonly buffered: ExternalParticipantNotification[] = []
  private readonly waiters: Array<{
    resolve(value: IteratorResult<ExternalParticipantNotification>): void
    reject(error: Error): void
  }> = []
  private ended = false
  private failure: Error | undefined

  push(notification: ExternalParticipantNotification): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: notification })
      return
    }
    if (this.buffered.length >= MAX_EXTERNAL_PARTICIPANT_BUFFERED_NOTIFICATIONS) {
      // Notifications signal durable protocol facts, so eviction or silent
      // dropping can hide an exit/event. Fail the participant and replay after
      // a clean reattach instead.
      throw new Error(
        `external participant notification queue exceeded ${MAX_EXTERNAL_PARTICIPANT_BUFFERED_NOTIFICATIONS}`
      )
    }
    this.buffered.push(notification)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined })
    }
  }

  fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    this.buffered.length = 0
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<ExternalParticipantNotification> {
    return {
      next: async () => {
        const notification = this.buffered.shift()
        if (notification !== undefined) return { done: false, value: notification }
        if (this.failure !== undefined) throw this.failure
        if (this.ended) return { done: true, value: undefined }
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
    }
  }
}

class NdjsonExternalParticipantClient implements ExternalParticipantRpcClient {
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private nextId = 1
  private buffer = ''
  private bufferBytes = 0
  private closed = false
  private readonly notificationQueue = new ExternalParticipantNotificationQueue()
  private readonly closedPromise: Promise<void>
  private resolveClosed!: () => void

  constructor(private readonly socket: import('node:net').Socket) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.onData(String(chunk)))
    socket.on('error', (error) => this.failAll(error))
    socket.on('close', () => this.failAll(new Error('external participant socket closed')))
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('external participant socket is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error === null || error === undefined) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('external participant socket is closed'))
    return new Promise((resolve, reject) => {
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, (error) => {
        if (error === null || error === undefined) resolve()
        else reject(error)
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.failAll(new Error('external participant client closed'))
  }

  streamNotifications(): AsyncIterable<ExternalParticipantNotification> {
    return this.notificationQueue
  }

  waitForClose(): Promise<void> {
    return this.closedPromise
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    this.bufferBytes += Buffer.byteLength(chunk, 'utf8')
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) {
        if (this.bufferBytes > MAX_EXTERNAL_PARTICIPANT_NDJSON_LINE_BYTES) {
          this.failInput(
            new Error(
              `external participant NDJSON line exceeded ${MAX_EXTERNAL_PARTICIPANT_NDJSON_LINE_BYTES} bytes`
            )
          )
        }
        return
      }
      const rawLine = this.buffer.slice(0, newline)
      const consumed = this.buffer.slice(0, newline + 1)
      this.buffer = this.buffer.slice(newline + 1)
      this.bufferBytes -= Buffer.byteLength(consumed, 'utf8')
      if (Buffer.byteLength(rawLine, 'utf8') > MAX_EXTERNAL_PARTICIPANT_NDJSON_LINE_BYTES) {
        this.failInput(
          new Error(
            `external participant NDJSON line exceeded ${MAX_EXTERNAL_PARTICIPANT_NDJSON_LINE_BYTES} bytes`
          )
        )
        return
      }
      const line = rawLine.trim()
      if (line.length === 0) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.failAll(new Error('external participant sent invalid JSON'))
        this.socket.destroy()
        return
      }
      if (!isRecord(message)) continue
      if (!Number.isInteger(message['id'])) {
        if (
          message['jsonrpc'] === '2.0' &&
          typeof message['method'] === 'string' &&
          !Object.hasOwn(message, 'id')
        ) {
          try {
            this.notificationQueue.push({
              method: message['method'],
              params: message['params'],
            })
          } catch (error) {
            this.failInput(error instanceof Error ? error : new Error(String(error)))
            return
          }
        }
        continue
      }
      const pending = this.pending.get(message['id'] as number)
      if (pending === undefined) continue
      this.pending.delete(message['id'] as number)
      if (isRecord(message['error'])) {
        const code = message['error']['code']
        const detail = message['error']['message']
        const error = new Error(
          `external participant RPC ${String(code)}: ${typeof detail === 'string' ? detail : 'error'}`
        ) as Error & { code?: number }
        if (typeof code === 'number') error.code = code
        pending.reject(error)
      } else if ('result' in message) {
        pending.resolve(message['result'])
      } else {
        pending.reject(new Error('external participant sent malformed JSON-RPC response'))
      }
    }
  }

  private failInput(error: Error): void {
    this.buffer = ''
    this.bufferBytes = 0
    this.failAll(error, true)
    this.socket.destroy()
  }

  private failAll(error: Error, discardNotifications = false): void {
    if (!this.closed) this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (discardNotifications) this.notificationQueue.fail(error)
    else this.notificationQueue.end()
    this.resolveClosed()
  }
}

export const connectExternalParticipant: ExternalParticipantClientFactory = ({
  socketPath,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
}) =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out connecting to external participant at ${socketPath}`))
    }, timeoutMs)
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.once('connect', () => {
      clearTimeout(timeout)
      resolve(new NdjsonExternalParticipantClient(socket))
    })
  })
