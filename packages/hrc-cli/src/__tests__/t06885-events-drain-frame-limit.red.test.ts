import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcServer } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function runDrain(
  runtimeRoot: string,
  dbPath: string,
  sourceRef: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      CLI_PATH,
      'admin',
      'events',
      'drain',
      dbPath,
      '--source-ref',
      sourceRef,
      '--json',
    ],
    {
      env: { ...process.env, HRC_RUNTIME_DIR: runtimeRoot },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe('T-06885 event drain frame sizing', () => {
  test('CLI drains a dead ledger larger than 1 MiB completely and re-drain is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-t06885-'))
    roots.push(root)
    const deadRoot = join(root, 'dead')
    const hostRoot = join(root, 'host', 'runtime')
    const hostStateRoot = join(root, 'host', 'state')
    const deadPath = join(deadRoot, 'state.sqlite')
    const hostPath = join(hostStateRoot, 'state.sqlite')
    const sourceRef = 'devbox-room:T-06885:oversized-dead-ledger'
    const payloadText = 'x'.repeat(12_000)
    const eventCount = 120

    await mkdir(deadRoot, { recursive: true })
    const dead = openHrcDatabase(deadPath)
    for (let index = 1; index <= eventCount; index += 1) {
      dead.hrcEvents.append({
        ts: '2026-07-24T01:02:03.000Z',
        hostSessionId: 'dead-session',
        scopeRef: 'agent:cody:project:devbox:task:T-06885',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'dead-runtime',
        runId: 'dead-run',
        category: 'turn',
        eventKind: 'assistant.message.completed',
        transport: 'headless',
        replayed: false,
        payload: { index, text: payloadText },
      })
    }
    dead.close()

    const server = await createHrcServer({
      runtimeRoot: hostRoot,
      stateRoot: hostStateRoot,
      socketPath: join(hostRoot, 'hrc.sock'),
      lockPath: join(hostRoot, 'server.lock'),
      spoolDir: join(hostRoot, 'spool'),
      dbPath: hostPath,
      tmuxSocketPath: join(hostRoot, 'tmux.sock'),
    })
    let host: ReturnType<typeof openHrcDatabase> | undefined
    try {
      const first = await runDrain(hostRoot, deadPath, sourceRef)
      expect(first).toMatchObject({ exitCode: 0, stderr: '' })
      expect(Buffer.byteLength(first.stdout)).toBeLessThan(1_048_576)
      expect(JSON.parse(first.stdout)).toMatchObject({ sourceRef, forwarded: eventCount })
      host = openHrcDatabase(hostPath)
      expect(host.hrcEvents.listFromHrcSeq(1, { sourceRef })).toHaveLength(eventCount)

      const second = await runDrain(hostRoot, deadPath, sourceRef)
      expect(second).toMatchObject({ exitCode: 0, stderr: '' })
      expect(JSON.parse(second.stdout)).toMatchObject({ sourceRef, forwarded: 0 })
      expect(host.hrcEvents.listFromHrcSeq(1, { sourceRef })).toHaveLength(eventCount)
    } finally {
      host?.close()
      await server.stop()
    }
  })
})
