import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { CaptureResponse } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-windows-')
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('/v1/windows', () => {
  let server: HrcServer

  beforeEach(async () => {
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('ensures a command window by sessionRef, then accepts literal input and capture by runtimeId', async () => {
    const sessionRef = 'agent:larry:project:agent-spaces:task:windows-smoke/lane:default'

    const ensureRes = await fixture.postJson('/v1/windows/ensure', {
      sessionRef,
      command: {
        launchMode: 'exec',
        argv: ['/bin/cat'],
      },
    })

    expect(ensureRes.status).toBe(200)
    const ensured = (await ensureRes.json()) as {
      hostSessionId: string
      generation: number
      runtimeId: string
      transport: string
      status: string
      tmux: {
        sessionId: string
        windowId: string
        paneId: string
      }
    }
    expect(ensured.hostSessionId).toBeString()
    expect(ensured.generation).toBe(1)
    expect(ensured.runtimeId).toBeString()
    expect(ensured.transport).toBe('tmux')
    expect(ensured.status).toBe('ready')
    expect(ensured.tmux.paneId).toBeString()

    const inputRes = await fixture.postJson('/v1/windows/literal-input', {
      runtimeId: ensured.runtimeId,
      text: 'windows smoke',
      enter: true,
    })
    expect(inputRes.status).toBe(200)

    await Bun.sleep(150)

    const captureRes = await fixture.fetchSocket(
      `/v1/windows/capture?runtimeId=${encodeURIComponent(ensured.runtimeId)}`
    )
    expect(captureRes.status).toBe(200)
    const capture = (await captureRes.json()) as CaptureResponse
    expect(capture.text).toContain('windows smoke')
  })

  it('proxies attach, interrupt, and terminate by runtimeId', async () => {
    const ensureRes = await fixture.postJson('/v1/windows/ensure', {
      sessionRef: 'agent:larry:project:agent-spaces:task:windows-lifecycle/lane:default',
      command: {
        launchMode: 'exec',
        argv: ['/bin/cat'],
      },
    })
    expect(ensureRes.status).toBe(200)
    const ensured = (await ensureRes.json()) as { runtimeId: string }

    const attachRes = await fixture.fetchSocket(
      `/v1/windows/attach?runtimeId=${encodeURIComponent(ensured.runtimeId)}`
    )
    expect(attachRes.status).toBe(200)
    const attach = (await attachRes.json()) as { argv: string[]; transport: string }
    expect(attach.transport).toBe('tmux')
    expect(Array.isArray(attach.argv)).toBe(true)
    expect(attach.argv.length).toBeGreaterThan(0)

    const interruptRes = await fixture.postJson('/v1/windows/interrupt', {
      runtimeId: ensured.runtimeId,
    })
    expect(interruptRes.status).toBe(200)

    const terminateRes = await fixture.postJson('/v1/windows/terminate', {
      runtimeId: ensured.runtimeId,
    })
    expect(terminateRes.status).toBe(200)
  })
})
