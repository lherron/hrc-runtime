/**
 * T-06970 — one message-selector grammar across show/thread/trace.
 *
 * The matrix `{bare numeric, seq:, @N, #N, bare UUID, msg:UUID} x {show, thread, trace}`
 * must have every cell defined: an accept that resolves the same message, or an
 * actionable rejection. Printed identities (`@N/#N`) must round-trip into the
 * command that printed them.
 */
import { describe, expect, test } from 'bun:test'

import type {
  HrcCollectiveMessageRecord,
  HrcMessageFilter,
  ListMessagesResponse,
  TraceMessageRequest,
  TraceMessageResponse,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { cmdShow } from '../commands/show.js'
import { cmdThread } from '../commands/thread.js'
import { cmdTrace } from '../commands/trace.js'

const ROOT_ID = 'msg-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REPLY_ID = 'msg-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LEGACY_ID = 'msg-cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/** Node-local seq and collective seq deliberately differ, as they do on svc. */
const ROOT_MESSAGE_SEQ = 12
const ROOT_COLLECTIVE_SEQ = 17_932
const LEGACY_MESSAGE_SEQ = 7

function record(
  input: Pick<HrcCollectiveMessageRecord, 'messageSeq' | 'messageId'> &
    Partial<
      Pick<
        HrcCollectiveMessageRecord,
        'collectiveSeq' | 'replyToMessageId' | 'rootMessageId' | 'phase' | 'body'
      >
    >
): HrcCollectiveMessageRecord {
  return {
    createdAt: '2026-07-25T10:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: { kind: 'session', sessionRef: 'agent:clod:project:hrc-runtime/lane:main' },
    rootMessageId: input.rootMessageId ?? ROOT_ID,
    body: 'selector fixture',
    bodyFormat: 'text/plain',
    execution: { state: 'not_applicable' },
    ...input,
  }
}

const COLLECTIVE_CORPUS = [
  record({
    messageSeq: ROOT_MESSAGE_SEQ,
    collectiveSeq: ROOT_COLLECTIVE_SEQ,
    messageId: ROOT_ID,
  }),
  record({
    messageSeq: 13,
    collectiveSeq: ROOT_COLLECTIVE_SEQ + 1,
    messageId: REPLY_ID,
    replyToMessageId: ROOT_ID,
    phase: 'response',
  }),
] satisfies HrcCollectiveMessageRecord[]

/** Pre-collective daemon: `collectiveSeq` absent, so seq means node-local seq. */
const LEGACY_CORPUS = [
  record({
    messageSeq: LEGACY_MESSAGE_SEQ,
    messageId: LEGACY_ID,
    rootMessageId: LEGACY_ID,
  }),
] satisfies HrcCollectiveMessageRecord[]

type Recorder = {
  readonly filters: HrcMessageFilter[]
  readonly traces: TraceMessageRequest[]
}

function fakeClient(corpus: HrcCollectiveMessageRecord[], recorder: Recorder): HrcClient {
  const seqOf = (candidate: HrcCollectiveMessageRecord): number =>
    candidate.collectiveSeq ?? candidate.messageSeq

  return {
    async listMessages(filter?: HrcMessageFilter): Promise<ListMessagesResponse> {
      recorder.filters.push(filter ?? {})
      let messages = corpus
      if (filter?.messageId !== undefined) {
        messages = messages.filter((candidate) => candidate.messageId === filter.messageId)
      }
      if (filter?.afterSeq !== undefined) {
        const afterSeq = filter.afterSeq
        messages = messages.filter((candidate) => seqOf(candidate) > afterSeq)
      }
      if (filter?.thread !== undefined) {
        const rootMessageId = filter.thread.rootMessageId
        messages = messages.filter((candidate) => candidate.rootMessageId === rootMessageId)
      }
      if (filter?.limit !== undefined) messages = messages.slice(0, filter.limit)
      return { messages }
    },
    async traceMessage(request: TraceMessageRequest): Promise<TraceMessageResponse> {
      recorder.traces.push(request)
      const found =
        request.messageId === undefined
          ? corpus.find((candidate) => candidate.messageSeq === request.messageSeq)
          : corpus.find((candidate) => candidate.messageId === request.messageId)
      if (found === undefined) {
        throw new Error(`message not found: ${JSON.stringify(request)}`)
      }
      return {
        localNodeId: 'svc',
        message: found,
        history: {
          source: 'collective',
          complete: true,
          authorityNodeId: 'svc',
          queriedNodeId: 'svc',
          cursorKind: 'collective',
          pendingReplicationCount: 0,
        },
        verdict: { code: 'local_message', summary: 'local message' },
      }
    },
  } as HrcClient
}

async function capture(run: () => Promise<void>): Promise<string> {
  let output = ''
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    await run()
  } finally {
    process.stdout.write = originalWrite
  }
  return output
}

type Command = 'show' | 'thread' | 'trace'

async function runCommand(
  command: Command,
  client: HrcClient,
  selector: string
): Promise<{ output: string; resolvedMessageId: string }> {
  let resolvedMessageId = ''
  const output = await capture(async () => {
    if (command === 'show') {
      await cmdShow(client, { json: true }, [selector])
      return
    }
    if (command === 'thread') {
      await cmdThread(client, { json: true }, [selector])
      return
    }
    await cmdTrace(client, { json: true }, [selector])
  })
  const parsed = JSON.parse(output) as Record<string, unknown>
  if (command === 'show') {
    resolvedMessageId = String(parsed.messageId)
  } else if (command === 'thread') {
    resolvedMessageId = String((parsed.anchor as Record<string, unknown>).messageId)
  } else {
    resolvedMessageId = String((parsed.message as Record<string, unknown>).messageId)
  }
  return { output, resolvedMessageId }
}

const COMMANDS: Command[] = ['show', 'thread', 'trace']

/** Every accepting selector form, all naming the same fixture message. */
const ACCEPTED_SELECTORS: ReadonlyArray<{ label: string; selector: string }> = [
  { label: 'bare numeric (collectiveSeq)', selector: String(ROOT_COLLECTIVE_SEQ) },
  { label: 'seq: alias', selector: `seq:${ROOT_COLLECTIVE_SEQ}` },
  { label: '@N collective identity', selector: `@${ROOT_COLLECTIVE_SEQ}` },
  { label: '#N node-local identity', selector: `#${ROOT_MESSAGE_SEQ}` },
  { label: 'bare message id', selector: ROOT_ID },
  { label: 'msg: prefixed message id', selector: `msg:${ROOT_ID}` },
]

describe('T-06970 selector x command matrix', () => {
  for (const command of COMMANDS) {
    for (const { label, selector } of ACCEPTED_SELECTORS) {
      test(`${command} accepts ${label} (${selector})`, async () => {
        const recorder: Recorder = { filters: [], traces: [] }
        const client = fakeClient(COLLECTIVE_CORPUS, recorder)
        const { resolvedMessageId } = await runCommand(command, client, selector)
        expect(resolvedMessageId).toBe(ROOT_ID)
      })
    }
  }

  test('printed @N/#N identity round-trips into the command that printed it', async () => {
    const recorder: Recorder = { filters: [], traces: [] }
    const client = fakeClient(COLLECTIVE_CORPUS, recorder)
    const rendered = await capture(async () => {
      await cmdThread(client, { json: false }, [String(ROOT_COLLECTIVE_SEQ)])
    })
    const identity = rendered.match(/@(\d+)\/#(\d+)/)
    expect(identity).not.toBeNull()
    const [, collectiveSeq, messageSeq] = identity as RegExpMatchArray

    for (const command of COMMANDS) {
      for (const printed of [`@${collectiveSeq}`, `#${messageSeq}`]) {
        const round = await runCommand(command, fakeClient(COLLECTIVE_CORPUS, recorder), printed)
        expect(round.resolvedMessageId).toBe(ROOT_ID)
      }
    }
  })

  test('trace resolves through the shared resolver and traces by messageId', async () => {
    const recorder: Recorder = { filters: [], traces: [] }
    const client = fakeClient(COLLECTIVE_CORPUS, recorder)
    await runCommand('trace', client, String(ROOT_COLLECTIVE_SEQ))
    expect(recorder.traces).toEqual([{ messageId: ROOT_ID }])
  })

  test('collectiveSeq lookup still pushes an exact messageId filter for id selectors', async () => {
    const recorder: Recorder = { filters: [], traces: [] }
    const client = fakeClient(COLLECTIVE_CORPUS, recorder)
    await runCommand('show', client, ROOT_ID)
    expect(recorder.filters[0]).toEqual({ messageId: ROOT_ID, limit: 1 })
  })
})

describe('T-06970 absent collectiveSeq fixture', () => {
  for (const command of COMMANDS) {
    test(`${command} resolves a bare numeric against messageSeq when collectiveSeq is absent`, async () => {
      const recorder: Recorder = { filters: [], traces: [] }
      const client = fakeClient(LEGACY_CORPUS, recorder)
      const { resolvedMessageId } = await runCommand(command, client, String(LEGACY_MESSAGE_SEQ))
      expect(resolvedMessageId).toBe(LEGACY_ID)
    })

    test(`${command} resolves #N against messageSeq when collectiveSeq is absent`, async () => {
      const recorder: Recorder = { filters: [], traces: [] }
      const client = fakeClient(LEGACY_CORPUS, recorder)
      const { resolvedMessageId } = await runCommand(command, client, `#${LEGACY_MESSAGE_SEQ}`)
      expect(resolvedMessageId).toBe(LEGACY_ID)
    })
  }

  test('messages-style #N-only identity round-trips when collectiveSeq is absent', async () => {
    const recorder: Recorder = { filters: [], traces: [] }
    const client = fakeClient(LEGACY_CORPUS, recorder)
    const rendered = await capture(async () => {
      await cmdThread(client, { json: false }, [`#${LEGACY_MESSAGE_SEQ}`])
    })
    expect(rendered).toContain(`#${LEGACY_MESSAGE_SEQ}`)
    expect(rendered).not.toContain('@undefined')
  })
})

describe('T-06970 actionable rejections', () => {
  const REJECTIONS: ReadonlyArray<{ selector: string; message: RegExp }> = [
    { selector: '@abc', message: /invalid collective sequence: @abc/ },
    { selector: '@0', message: /invalid collective sequence: @0/ },
    { selector: '#abc', message: /invalid message sequence: #abc/ },
    { selector: '#0', message: /invalid message sequence: #0/ },
    { selector: 'seq:abc', message: /invalid message sequence: seq:abc/ },
    { selector: 'seq:', message: /invalid message sequence: seq:/ },
    { selector: 'msg:', message: /invalid message ID: msg:/ },
    { selector: '   ', message: /message selector must not be empty/ },
  ]

  for (const command of COMMANDS) {
    for (const { selector, message } of REJECTIONS) {
      test(`${command} rejects ${JSON.stringify(selector)} actionably`, async () => {
        const recorder: Recorder = { filters: [], traces: [] }
        const client = fakeClient(COLLECTIVE_CORPUS, recorder)
        await expect(runCommand(command, client, selector)).rejects.toThrow(message)
        expect(recorder.filters).toEqual([])
        expect(recorder.traces).toEqual([])
      })
    }

    test(`${command} reports an unresolvable collective seq as not found`, async () => {
      const recorder: Recorder = { filters: [], traces: [] }
      const client = fakeClient(COLLECTIVE_CORPUS, recorder)
      await expect(runCommand(command, client, '@999999')).rejects.toThrow(
        /message not found: @999999/
      )
    })
  }
})
