import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Server } from 'bun'

import { HrcClient } from '../client'

let stubServer: Server | undefined
let stubSocketPath: string

beforeEach(() => {
  stubSocketPath = `/tmp/hrc-sdk-command-run-${process.pid}-${Date.now()}.sock`
})

afterEach(() => {
  stubServer?.stop(true)
  stubServer = undefined
})

describe('HrcClient.launchCommandScopedRun (T-05274 red)', () => {
  it('posts a structured binding and configured target without client-supplied command material', async () => {
    let capturedPath = ''
    let capturedBody: Record<string, unknown> | undefined

    stubServer = Bun.serve({
      unix: stubSocketPath,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname
        capturedBody = (await req.json()) as Record<string, unknown>
        return Response.json({
          runId: 'run-command-1',
          hostSessionId: 'hsid-command-1',
          runtimeId: 'rt-command-1',
          generation: 7,
          transport: 'tmux',
          launchId: 'launch-command-1',
          replayed: false,
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const result = await client.launchCommandScopedRun({
      configuredTargetId: 'wrkf-action-runner',
      sessionRef: 'agent:larry/project:hrc-runtime/task:T-05274/lane:main',
      idempotencyKey: 'wrkf-action-run-123',
      binding: {
        WRKF_TASK_ID: 'T-05274',
        WRKF_ACTION_RUN_ID: 'action-run-123',
        WRKF_RUN_ID: 'wrkf-run-123',
        WRKF_ACTION: 'triage',
        WRKF_ROLE: 'implementer',
        ASP_PROJECT: 'hrc-runtime',
        HRC_SESSION_REF: 'agent:larry/project:hrc-runtime/task:T-05274/lane:main',
        HRC_LANE: 'main',
      },
      stdinJson: { mode: 'smoke' },
    })

    expect(capturedPath).toBe('/v1/command-runs/launch')
    expect(capturedBody).toEqual({
      configuredTargetId: 'wrkf-action-runner',
      sessionRef: 'agent:larry/project:hrc-runtime/task:T-05274/lane:main',
      idempotencyKey: 'wrkf-action-run-123',
      binding: {
        WRKF_TASK_ID: 'T-05274',
        WRKF_ACTION_RUN_ID: 'action-run-123',
        WRKF_RUN_ID: 'wrkf-run-123',
        WRKF_ACTION: 'triage',
        WRKF_ROLE: 'implementer',
        ASP_PROJECT: 'hrc-runtime',
        HRC_SESSION_REF: 'agent:larry/project:hrc-runtime/task:T-05274/lane:main',
        HRC_LANE: 'main',
      },
      stdinJson: { mode: 'smoke' },
    })
    expect(capturedBody).not.toHaveProperty('command')
    expect(capturedBody).not.toHaveProperty('argv')
    expect(capturedBody).not.toHaveProperty('cwd')
    expect(capturedBody).not.toHaveProperty('env')
    expect(result.runId).toBe('run-command-1')
    expect(result.runtimeId).toBe('rt-command-1')
  })
})
