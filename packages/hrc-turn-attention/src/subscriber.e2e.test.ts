import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolation failure modes: task scope accidentally sent; stale text from another
// turn used; cursor lost on restart; HTTP failure retried; none omitted; key leaked.
// Each case drives the actual CLI process over a Unix socket and real jev API.
const key = process.env['TYPESAFE_API_KEY']
const live = key ? test : test.skip
live(
  'subscriber process: catch-up, restart text, task exclusion, none and fail-open',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-e2e-'))
    const socket = join(dir, 'hrc.sock')
    const state = join(dir, 'cursor.json')
    const appends: any[] = []
    let rows: any[] = []
    let streamMode = false
    const event = (seq: number, kind: string, payload: unknown, seat = 'primary') => ({
      hrcSeq: seq,
      streamSeq: seq,
      ts: new Date().toISOString(),
      hostSessionId: 'hsid-fixture',
      scopeRef: `agent:cody:project:hrc-runtime:task:${seat}`,
      laneRef: 'main',
      generation: 1,
      runtimeId: 'rt-fixture',
      category: 'turn',
      eventKind: kind,
      replayed: false,
      payload,
    })
    const server = Bun.serve({
      unix: socket,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/v1/events/page') {
          const after = Number(url.searchParams.get('afterSeq'))
          return Response.json({
            ledgerIncarnationId: 'ledger-fixture',
            head: streamMode ? after : (rows.at(-1)?.hrcSeq ?? after),
            scannedThrough: streamMode ? after : (rows.at(-1)?.hrcSeq ?? after),
            rows: streamMode ? [] : rows.filter((r) => r.hrcSeq > after),
          })
        }
        if (url.pathname === '/v1/events/append') {
          appends.push(await request.json())
          return Response.json({ appended: true })
        }
        if (url.pathname === '/v1/events/bounded-stream') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `${JSON.stringify({
                      type: 'ready',
                      ledgerIncarnationId: 'ledger-fixture',
                      acceptedAfterHrcSeq: Number(url.searchParams.get('afterSeq')),
                      replayHeadHrcSeq: rows.at(-1)?.hrcSeq,
                    })}\n`
                  )
                )
                if (streamMode)
                  for (const row of rows)
                    controller.enqueue(
                      new TextEncoder().encode(
                        `${JSON.stringify({ type: 'event', ledgerIncarnationId: 'ledger-fixture', event: row })}\n`
                      )
                    )
              },
            })
          )
        }
        return new Response('unexpected route', { status: 500 })
      },
    })
    let child: ReturnType<typeof Bun.spawn> | undefined
    const drive = async (turns: Record<string, unknown>, newRows: any[], apiKey: string) => {
      rows = newRows
      await writeFile(
        state,
        JSON.stringify({ ledgerIncarnationId: 'ledger-fixture', afterSeq: 0, turns })
      )
      child = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts')], {
        env: {
          ...process.env,
          HRC_SOCKET_PATH: socket,
          HRC_TURN_ATTENTION_STATE_PATH: state,
          TYPESAFE_API_KEY: apiKey,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        const cursor = JSON.parse(await readFile(state, 'utf8'))
        if (cursor.afterSeq === rows.at(-1).hrcSeq) break
        await Bun.sleep(25)
      }
      expect(JSON.parse(await readFile(state, 'utf8')).afterSeq).toBe(rows.at(-1).hrcSeq)
      child.kill()
      await child.exited
      const logs = await new Response(child.stderr).text()
      expect(logs).not.toContain(apiKey)
      return logs
    }
    try {
      const completion = { turnId: 'turn_inv-fixture_1', invocationId: 'inv-fixture' }
      await drive(
        {
          'hsid-fixture:1': {
            user: 'Report on the work in hand',
            final: 'Should I commit and push? Waiting on your go.',
          },
        },
        [event(1, 'turn.completed', completion)],
        key!
      )
      expect(appends).toHaveLength(1)
      expect(appends[0]).toMatchObject({
        eventKind: 'turn.attention',
        runtimeId: 'rt-fixture',
        turnId: completion.turnId,
        payload: { lit: true, classifierVersion: 'attention-v3' },
      })
      await drive(
        {},
        [
          event(
            1,
            'turn.message',
            { type: 'message_end', message: { role: 'assistant', content: 'Should I commit?' } },
            'T-12018'
          ),
          event(2, 'turn.completed', completion, 'T-12018'),
        ],
        key!
      )
      expect(appends).toHaveLength(1)
      streamMode = true
      await drive(
        {},
        [
          event(1, 'turn.message', {
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Build passed. The change is committed and pushed.' },
              ],
            },
          }),
          event(2, 'turn.completed', completion),
        ],
        key!
      )
      expect(appends).toHaveLength(2)
      expect(appends[1].payload).toMatchObject({ lit: false, state: 'none' })
      streamMode = false
      const logs = await drive(
        { 'hsid-fixture:1': { user: '', final: 'Should I commit and push?' } },
        [event(1, 'turn.completed', completion)],
        'invalid-attention-key'
      )
      expect(appends).toHaveLength(2)
      // The drop is one structured log line, in the fleet's JSON log shape.
      const dropped = logs
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .filter((line) => line.event === 'turn_attention.dropped')
      expect(dropped).toHaveLength(1)
      expect(dropped[0]).toMatchObject({
        level: 'warn',
        component: 'hrc-turn-attention',
        data: { turnId: completion.turnId },
      })
      expect(String(dropped[0].data.error)).toContain('401')
    } finally {
      child?.kill()
      if (child) await child.exited
      server.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  },
  40000
)
