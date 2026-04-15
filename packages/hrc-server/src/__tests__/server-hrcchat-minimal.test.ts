import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcTargetView, ListMessagesResponse, SemanticDmResponse } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-hrcchat-minimal-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('hrcchat minimal server routes', () => {
  it('lists targets and normalizes legacy default lanes to main', async () => {
    await fixture.resolveSession('agent:cody:project:agent-spaces')

    const res = await fixture.fetchSocket('/v1/targets')
    expect(res.status).toBe(200)

    const targets = (await res.json()) as HrcTargetView[]
    expect(targets).toHaveLength(1)
    expect(targets[0]?.sessionRef).toBe('agent:cody:project:agent-spaces/lane:main')
    expect(targets[0]?.laneRef).toBe('main')
    expect(targets[0]?.state).toBe('summoned')
  })

  it('looks up a single target by sessionRef with main/default aliasing', async () => {
    await fixture.resolveSession('agent:clod:project:agent-spaces')

    const res = await fixture.fetchSocket(
      '/v1/targets/by-session-ref?sessionRef=agent%3Aclod%3Aproject%3Aagent-spaces%2Flane%3Amain'
    )
    expect(res.status).toBe(200)

    const target = (await res.json()) as HrcTargetView
    expect(target.sessionRef).toBe('agent:clod:project:agent-spaces/lane:main')
    expect(target.scopeRef).toBe('agent:clod:project:agent-spaces')
  })

  it('appends durable dm records and returns them through messages/query', async () => {
    const dmRes = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
      body: 'ping from cody',
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(dm.request.kind).toBe('dm')
    expect(dm.request.phase).toBe('request')
    expect(dm.request.to).toEqual({
      kind: 'session',
      sessionRef: 'agent:clod:project:agent-spaces/lane:main',
    })

    const listRes = await fixture.postJson('/v1/messages/query', {
      participant: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
    })
    expect(listRes.status).toBe(200)

    const listed = (await listRes.json()) as ListMessagesResponse
    expect(listed.messages).toHaveLength(1)
    expect(listed.messages[0]?.messageId).toBe(dm.request.messageId)
    expect(listed.messages[0]?.body).toBe('ping from cody')
  })
})
