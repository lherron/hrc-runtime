import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'

const INPUT_ID = 'input-t08207-read'
const CARRIER_RUN_ID = 'run-t08207-carrier'
const TURN_ID = 'turn-t08207-carrier'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08207-input-api-')
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.inputs.insert({
      inputId: INPUT_ID,
      admissionHostSessionId: 'hsid-t08207-admission',
      idempotencyKey: 'idem-t08207',
      requestHash: 'sha256:t08207',
      hostSessionId: 'hsid-t08207-current',
      runtimeId: 'rt-t08207',
      operationId: 'op-t08207',
      invocationId: 'inv-t08207',
      brokerSubmissionId: 'submission-t08207',
      door: 'invoke',
      admissionClass: 'exclusive',
      origin: 'agent:cody',
      status: 'initiating',
      cleanupProtection: 'carrier-run',
      landingKind: 'initiating',
      carrierRunId: CARRIER_RUN_ID,
      turnId: TURN_ID,
      runStartedHrcSeq: 73,
      admittedAt: now,
      landedAt: now,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
  const eventDb = openHrcDatabase(fixture.dbPath)
  try {
    eventDb.hrcEvents.append({
      ts: now,
      hostSessionId: 'hsid-t08207-current',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-08207',
      laneRef: 'main',
      generation: 1,
      runtimeId: 'rt-t08207',
      runId: CARRIER_RUN_ID,
      category: 'input',
      eventKind: 'input.landed',
      payload: {
        inputId: INPUT_ID,
        kind: 'initiating',
        carrierRunId: CARRIER_RUN_ID,
        turnId: TURN_ID,
        brokerSubmissionId: 'submission-t08207',
        runStartedHrcSeq: 73,
      },
    })
  } finally {
    eventDb.close()
  }
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  await fixture.cleanup()
})

describe('T-08207 canonical input HTTP reads', () => {
  it('reads an exact input record without projecting it as a run', async () => {
    const response = await fixture.fetchSocket(`/v1/inputs/${INPUT_ID}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      input: expect.objectContaining({
        inputId: INPUT_ID,
        status: 'initiating',
        landingKind: 'initiating',
        carrierRunId: CARRIER_RUN_ID,
        turnId: TURN_ID,
        runStartedHrcSeq: 73,
      }),
    })
  })

  it('replays only the input landing fact on the canonical input watch', async () => {
    const response = await fixture.fetchSocket(`/v1/inputs/${INPUT_ID}/watch?follow=false`)

    expect(response.status).toBe(200)
    const events = (await response.text())
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(events).toEqual([
      {
        type: 'landing',
        inputId: INPUT_ID,
        kind: 'initiating',
        carrierRunId: CARRIER_RUN_ID,
        turnId: TURN_ID,
        brokerSubmissionId: 'submission-t08207',
        runStartedHrcSeq: 73,
      },
    ])
  })

  it('keeps teardown cancellation a correlation fact instead of an input terminal', async () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.hrcEvents.append({
        ts: fixture.now(),
        hostSessionId: 'hsid-t08207-current',
        scopeRef: 'agent:cody:project:hrc-runtime:task:T-08207',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-t08207',
        category: 'input',
        eventKind: 'input.correlation',
        payload: {
          inputId: INPUT_ID,
          fact: 'cancelled',
          detail: 'teardown',
        },
      })
    } finally {
      db.close()
    }

    const response = await fixture.fetchSocket(
      `/v1/inputs/${INPUT_ID}/watch?fromSeq=2&follow=false`
    )

    expect(response.status).toBe(200)
    expect(
      (await response.text())
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    ).toEqual([
      {
        type: 'correlation',
        inputId: INPUT_ID,
        fact: 'cancelled',
        detail: 'teardown',
      },
    ])
  })
})
