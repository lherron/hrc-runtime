import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { createServer as createUnixServer } from 'node:net'
import type { Socket, Server as UnixServer } from 'node:net'

import { connectExternalParticipant } from '../external-registration-rendezvous.js'
import type { ExternalParticipantRpcClient } from '../external-registration-rendezvous.js'

const EXPECTED_MAX_LINE_BYTES = 1024 * 1024
const EXPECTED_MAX_BUFFERED_NOTIFICATIONS = 1024

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function listen(server: UnixServer, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
}

async function waitForClose(client: ExternalParticipantRpcClient): Promise<'closed' | 'timeout'> {
  if (client.waitForClose === undefined) throw new Error('real NDJSON client has no close signal')
  return Promise.race([
    client.waitForClose().then(() => 'closed' as const),
    Bun.sleep(250).then(() => 'timeout' as const),
  ])
}

describe('T-07204 external participant resource bounds', () => {
  let server: UnixServer | undefined
  let client: ExternalParticipantRpcClient | undefined
  let peer: Socket | undefined
  let socketPath = ''

  afterEach(async () => {
    await client?.close().catch(() => undefined)
    peer?.destroy()
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    if (socketPath !== '') await rm(socketPath, { force: true })
  })

  async function connectRealClient(): Promise<Socket> {
    socketPath = `/tmp/epr-t07204-${crypto.randomUUID().slice(0, 8)}.sock`
    const accepted = deferred<Socket>()
    server = createUnixServer((socket) => {
      peer = socket
      accepted.resolve(socket)
    })
    await listen(server, socketPath)
    client = await connectExternalParticipant({ socketPath })
    return accepted.promise
  }

  test('terminates a participant whose NDJSON line exceeds the byte limit without a newline', async () => {
    const socket = await connectRealClient()

    socket.write('x'.repeat(EXPECTED_MAX_LINE_BYTES + 1))

    expect(await waitForClose(client!)).toBe('closed')
  })

  test('fails closed instead of dropping or growing past the notification queue limit', async () => {
    const socket = await connectRealClient()
    const burst = Array.from(
      { length: EXPECTED_MAX_BUFFERED_NOTIFICATIONS + 1 },
      (_, index) =>
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'invocation.event',
          params: { index },
        })}\n`
    ).join('')

    socket.write(burst)

    expect(await waitForClose(client!)).toBe('closed')
  })
})
