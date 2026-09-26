import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcClient } from '../index.js'

const INPUT = {
  inputId: 'input-t08207-sdk',
  admissionHostSessionId: 'hsid-t08207-admission',
  idempotencyKey: 'idem-t08207',
  requestHash: 'sha256:t08207',
  runtimeId: 'rt-t08207',
  invocationId: 'inv-t08207',
  brokerSubmissionId: 'submission-t08207',
  status: 'accepted',
  cleanupProtection: 'protected',
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
}

let tmpDir: string
let socketPath: string
let server: ReturnType<typeof Bun.serve> | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-t08207-input-'))
  socketPath = join(tmpDir, 'input.sock')
})

afterEach(async () => {
  server?.stop(true)
  server = undefined
  await rm(tmpDir, { recursive: true, force: true })
})

describe('T-08207 input SDK reads', () => {
  it('uses exact input paths and preserves typed nonterminal correlation facts', async () => {
    const requested: string[] = []
    server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        const url = new URL(request.url)
        requested.push(`${request.method} ${url.pathname}?${url.searchParams}`)
        if (url.pathname === `/v1/inputs/${INPUT.inputId}`) {
          return Response.json({ input: INPUT })
        }
        if (url.pathname === `/v1/inputs/${INPUT.inputId}/watch`) {
          return new Response(
            `${[
              JSON.stringify({
                type: 'correlation',
                inputId: INPUT.inputId,
                fact: 'cancelled',
                detail: 'teardown',
              }),
              JSON.stringify({
                type: 'landing',
                inputId: INPUT.inputId,
                kind: 'joined',
                carrierRunId: 'run-t08207-carrier',
                turnId: 'turn-t08207-carrier',
                brokerSubmissionId: INPUT.brokerSubmissionId,
                runStartedHrcSeq: 44,
              }),
            ].join('\n')}\n`,
            { headers: { 'content-type': 'application/x-ndjson' } }
          )
        }
        return new Response('not found', { status: 404 })
      },
    })

    const client = new HrcClient(socketPath)
    const read = await client.getInput(INPUT.inputId)
    const events: unknown[] = []
    for await (const event of client.watchInput({ inputId: INPUT.inputId, follow: false })) {
      events.push(event)
    }

    expect(read).toEqual({ input: INPUT })
    expect(events).toEqual([
      {
        type: 'correlation',
        inputId: INPUT.inputId,
        fact: 'cancelled',
        detail: 'teardown',
      },
      {
        type: 'landing',
        inputId: INPUT.inputId,
        kind: 'joined',
        carrierRunId: 'run-t08207-carrier',
        turnId: 'turn-t08207-carrier',
        brokerSubmissionId: INPUT.brokerSubmissionId,
        runStartedHrcSeq: 44,
      },
    ])
    expect(requested).toEqual([
      `GET /v1/inputs/${INPUT.inputId}?`,
      `GET /v1/inputs/${INPUT.inputId}/watch?`,
    ])
  })
})
