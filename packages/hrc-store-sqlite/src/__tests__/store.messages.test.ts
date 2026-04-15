/**
 * Tests for the hrcchat MessageRepository.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMessageAddress } from 'hrc-core'
import { openHrcDatabase } from '../index'
import type { HrcDatabase } from '../index'

let tmpDir: string
let db: HrcDatabase

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-msg-test-'))
  db = openHrcDatabase(join(tmpDir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

const humanAddr: HrcMessageAddress = { kind: 'entity', entity: 'human' }
const codyAddr: HrcMessageAddress = {
  kind: 'session',
  sessionRef: 'agent:cody:project:demo/lane:main',
}
const clodAddr: HrcMessageAddress = {
  kind: 'session',
  sessionRef: 'agent:clod:project:demo/lane:main',
}

describe('MessageRepository', () => {
  it('inserts and retrieves a message by id', () => {
    const msg = db.messages.insert({
      messageId: 'msg-001',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'Hello Cody',
    })

    expect(msg.messageId).toBe('msg-001')
    expect(msg.messageSeq).toBeGreaterThan(0)
    expect(msg.kind).toBe('dm')
    expect(msg.phase).toBe('request')
    expect(msg.from).toEqual(humanAddr)
    expect(msg.to).toEqual(codyAddr)
    expect(msg.body).toBe('Hello Cody')
    expect(msg.rootMessageId).toBe('msg-001') // self-root

    const fetched = db.messages.getById('msg-001')
    expect(fetched).toBeDefined()
    expect(fetched!.messageSeq).toBe(msg.messageSeq)
  })

  it('assigns monotonically increasing seq', () => {
    const m1 = db.messages.insert({
      messageId: 'msg-a',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'first',
    })
    const m2 = db.messages.insert({
      messageId: 'msg-b',
      kind: 'dm',
      phase: 'response',
      from: codyAddr,
      to: humanAddr,
      body: 'second',
      replyToMessageId: 'msg-a',
      rootMessageId: 'msg-a',
    })

    expect(m2.messageSeq).toBeGreaterThan(m1.messageSeq)
    expect(m2.replyToMessageId).toBe('msg-a')
    expect(m2.rootMessageId).toBe('msg-a')
  })

  it('queries by filter: from', () => {
    db.messages.insert({
      messageId: 'msg-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'from human',
    })
    db.messages.insert({
      messageId: 'msg-2',
      kind: 'dm',
      phase: 'response',
      from: codyAddr,
      to: humanAddr,
      body: 'from cody',
    })

    const fromHuman = db.messages.query({ from: humanAddr })
    expect(fromHuman).toHaveLength(1)
    expect(fromHuman[0].messageId).toBe('msg-1')

    const fromCody = db.messages.query({ from: codyAddr })
    expect(fromCody).toHaveLength(1)
    expect(fromCody[0].messageId).toBe('msg-2')
  })

  it('queries by filter: to', () => {
    db.messages.insert({
      messageId: 'msg-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'to cody',
    })

    const toCody = db.messages.query({ to: codyAddr })
    expect(toCody).toHaveLength(1)
  })

  it('queries by filter: participant', () => {
    db.messages.insert({
      messageId: 'msg-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'msg',
    })
    db.messages.insert({
      messageId: 'msg-2',
      kind: 'dm',
      phase: 'response',
      from: codyAddr,
      to: humanAddr,
      body: 'reply',
    })
    db.messages.insert({
      messageId: 'msg-3',
      kind: 'dm',
      phase: 'request',
      from: clodAddr,
      to: humanAddr,
      body: 'different',
    })

    const involving = db.messages.query({ participant: codyAddr })
    expect(involving).toHaveLength(2)
  })

  it('queries by filter: thread', () => {
    db.messages.insert({
      messageId: 'root-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'root',
    })
    db.messages.insert({
      messageId: 'reply-1',
      kind: 'dm',
      phase: 'response',
      from: codyAddr,
      to: humanAddr,
      body: 'reply',
      replyToMessageId: 'root-1',
      rootMessageId: 'root-1',
    })
    db.messages.insert({
      messageId: 'unrelated-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: clodAddr,
      body: 'unrelated',
    })

    const thread = db.messages.query({
      thread: { rootMessageId: 'root-1' },
    })
    expect(thread).toHaveLength(2)
  })

  it('queries with afterSeq and limit', () => {
    for (let i = 0; i < 5; i++) {
      db.messages.insert({
        messageId: `msg-${i}`,
        kind: 'dm',
        phase: 'oneway',
        from: humanAddr,
        to: codyAddr,
        body: `message ${i}`,
      })
    }

    const m2 = db.messages.getById('msg-1')!
    const after = db.messages.query({ afterSeq: m2.messageSeq, limit: 2 })
    expect(after).toHaveLength(2)
    expect(after[0].messageId).toBe('msg-2')
    expect(after[1].messageId).toBe('msg-3')
  })

  it('stores and retrieves execution metadata', () => {
    const msg = db.messages.insert({
      messageId: 'exec-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'test',
      execution: {
        state: 'completed',
        mode: 'nonInteractive',
        sessionRef: 'agent:cody:project:demo/lane:main',
        transport: 'sdk',
        runId: 'run-abc',
      },
    })

    expect(msg.execution.state).toBe('completed')
    expect(msg.execution.mode).toBe('nonInteractive')
    expect(msg.execution.transport).toBe('sdk')
    expect(msg.execution.runId).toBe('run-abc')
  })

  it('updates execution state', () => {
    db.messages.insert({
      messageId: 'upd-1',
      kind: 'dm',
      phase: 'request',
      from: humanAddr,
      to: codyAddr,
      body: 'test',
      execution: { state: 'accepted' },
    })

    db.messages.updateExecution('upd-1', {
      state: 'completed',
      runId: 'run-xyz',
    })

    const updated = db.messages.getById('upd-1')!
    expect(updated.execution.state).toBe('completed')
    expect(updated.execution.runId).toBe('run-xyz')
  })

  it('maxSeq returns 0 for empty store', () => {
    expect(db.messages.maxSeq()).toBe(0)
  })

  it('maxSeq returns correct value', () => {
    db.messages.insert({
      messageId: 'a',
      kind: 'dm',
      phase: 'oneway',
      from: humanAddr,
      to: codyAddr,
      body: 'a',
    })
    const m2 = db.messages.insert({
      messageId: 'b',
      kind: 'dm',
      phase: 'oneway',
      from: humanAddr,
      to: codyAddr,
      body: 'b',
    })
    expect(db.messages.maxSeq()).toBe(m2.messageSeq)
  })

  it('stores and retrieves metadata json', () => {
    const meta = { source: 'test', tags: ['a', 'b'] }
    const msg = db.messages.insert({
      messageId: 'meta-1',
      kind: 'system',
      phase: 'oneway',
      from: { kind: 'entity', entity: 'system' },
      to: humanAddr,
      body: 'system message',
      metadataJson: meta,
    })

    expect(msg.metadataJson).toEqual(meta)
    const fetched = db.messages.getById('meta-1')!
    expect(fetched.metadataJson).toEqual(meta)
  })
})
