import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { join } from 'node:path'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { runRecurringTmuxAging } from '../sweep-handlers'
import { TmuxCommandTimeoutError, createTmuxManager, isTmuxCommandTimeoutError } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const COMMAND_TIMEOUT_MS = 100
const PRE_FIX_WATCHDOG_MS = 750
const STOP_WATCHDOG_MS = 7_000

let socketServer: Server | undefined
let acceptedSockets = new Set<Socket>()
let tmpDir: string | undefined

afterEach(async () => {
  for (const socket of acceptedSockets) socket.destroy()
  acceptedSockets = new Set()
  if (socketServer) {
    const server = socketServer
    socketServer = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (tmpDir) {
    const dir = tmpDir
    tmpDir = undefined
    await rm(dir, { force: true, recursive: true })
  }
})

async function listenWithoutReply(socketPath: string): Promise<{ accepted: Promise<void> }> {
  let accepted!: () => void
  const acceptedPromise = new Promise<void>((resolve) => {
    accepted = resolve
  })
  socketServer = createServer((socket) => {
    acceptedSockets.add(socket)
    socket.once('close', () => acceptedSockets.delete(socket))
    accepted()
    // Intentionally accept the real tmux client's connection without replying.
  })
  await new Promise<void>((resolve, reject) => {
    socketServer?.once('error', reject)
    socketServer?.listen(socketPath, resolve)
  })
  return { accepted: acceptedPromise }
}

describe('T-07198 bounded tmux commands and shutdown', () => {
  test('ordinary tmux exec times out, SIGKILLs the real client, and closes its socket', async () => {
    tmpDir = await mkdtemp('/tmp/hrc-t07198-tmux-')
    const socketPath = join(tmpDir, 'wedged.sock')
    const { accepted } = await listenWithoutReply(socketPath)
    const manager = createTmuxManager({ socketPath, commandTimeoutMs: COMMAND_TIMEOUT_MS })
    const startedAt = performance.now()

    const outcome = await Promise.race([
      manager.listSessionNames().then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error })
      ),
      Bun.sleep(PRE_FIX_WATCHDOG_MS).then(() => ({ kind: 'hung' as const })),
    ])

    await accepted
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected') return
    expect(isTmuxCommandTimeoutError(outcome.error)).toBe(true)
    expect((outcome.error as TmuxCommandTimeoutError).timeoutMs).toBe(COMMAND_TIMEOUT_MS)
    expect(performance.now() - startedAt).toBeLessThan(PRE_FIX_WATCHDOG_MS)

    const clientClosed = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (acceptedSockets.size === 0) resolve(true)
        for (const socket of acceptedSockets) socket.once('close', () => resolve(true))
      }),
      Bun.sleep(PRE_FIX_WATCHDOG_MS).then(() => false),
    ])
    expect(clientClosed).toBe(true)
  })

  test('a timed-out recurring tmux aging pass clears singleflight state for the next tick', async () => {
    let calls = 0
    const context = {
      tmuxAgingInFlight: undefined,
      runTmuxAgingOnce: async () => {
        calls += 1
        if (calls === 1) throw new TmuxCommandTimeoutError('tmux list-panes', COMMAND_TIMEOUT_MS)
        return { ok: true }
      },
    }

    await runRecurringTmuxAging.call(context as never)
    expect(context.tmuxAgingInFlight).toBeUndefined()
    await runRecurringTmuxAging.call(context as never)
    expect(calls).toBe(2)
    expect(context.tmuxAgingInFlight).toBeUndefined()
  })

  test(
    'stop returns within the shutdown bound when active-run reconcile never settles',
    async () => {
      let fixture: HrcServerTestFixture | undefined
      let server: HrcServer | undefined
      let release!: () => void
      const wedged = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        fixture = await createHrcTestFixture('hrc-t07198-stop-')
        server = await createHrcServer(
          fixture.serverOpts({ otelListenerEnabled: false, tmuxAgingEnabled: false })
        )
        ;(
          server as never as { activeRunReconcileInFlight: Promise<void> }
        ).activeRunReconcileInFlight = wedged

        const stopping = server.stop()
        const outcome = await Promise.race([
          stopping.then(() => 'stopped' as const),
          Bun.sleep(STOP_WATCHDOG_MS).then(() => 'hung' as const),
        ])

        expect(outcome).toBe('stopped')
        release()
        await stopping
        server = undefined
      } finally {
        release()
        await server?.stop()
        await fixture?.cleanup()
      }
    },
    STOP_WATCHDOG_MS + 2_000
  )
})
