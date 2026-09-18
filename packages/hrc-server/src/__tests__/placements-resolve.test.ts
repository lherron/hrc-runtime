/**
 * T-08597 — placements/resolve route over the aspd observation double.
 *
 * Exercises the real HRC policy chain (override/registry/marker/sibling) plus
 * observation mapping without a live aspd. The double echoes the resolved
 * context; byte-parity against local resolution is proved by the route parity
 * table on the live node.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { HrcDomainError } from 'hrc-core'

import { handleResolvePlacement } from '../placements-resolve.js'
import {
  type AspdObservationDouble,
  startAspdObservationDouble,
} from './fixtures/aspd-observation-doubles.js'

let root: string
let projectRoot: string
let aspdSocket: string
let savedAspdSocket: string | undefined
let aspd: AspdObservationDouble | undefined

const release = {
  releaseId: 'asp-test-1',
  sourceCommit: 'c'.repeat(40),
  builtAt: '2026-09-18T00:00:00.000Z',
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't08597-placements-'))
  projectRoot = join(root, 'proj')
  await mkdir(join(projectRoot, '.git'), { recursive: true })
  aspdSocket = join(root, 'aspd.sock')
  savedAspdSocket = process.env['HRC_ASPD_SOCKET']
})

afterEach(async () => {
  aspd?.stop()
  aspd = undefined
  if (savedAspdSocket === undefined) Reflect.deleteProperty(process.env, 'HRC_ASPD_SOCKET')
  else process.env['HRC_ASPD_SOCKET'] = savedAspdSocket
  await rm(root, { recursive: true, force: true })
})

function boot(): void {
  aspd = startAspdObservationDouble(aspdSocket, release, {})
  process.env['HRC_ASPD_SOCKET'] = aspdSocket
}

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  // The server's route dispatch translates domain errors to responses;
  // direct handler calls translate here.
  try {
    const response = await handleResolvePlacement(
      new Request('http://hrc/v1/placements/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
    return { status: response.status, json: (await response.json()) as Record<string, unknown> }
  } catch (error) {
    if (error instanceof HrcDomainError) {
      return { status: error.status, json: error.toResponse() as Record<string, unknown> }
    }
    throw error
  }
}

describe('POST /v1/placements/resolve', () => {
  test('resolves an explicit registered project end to end', async () => {
    boot()
    const { status, json } = await post({
      agentId: 'smokey',
      projectId: 'proj',
      projectOrigin: 'explicit',
      cwd: root,
      runMode: 'task',
      registryProjects: [{ slug: 'proj', root: projectRoot }],
    })

    expect(status).toBe(200)
    expect(json['projectRoot']).toBe(projectRoot)
    expect(json['cwd']).toBe(projectRoot)
    expect(json['bundle']).toMatchObject({ kind: 'agent-project', agentName: 'smokey' })
    expect(json['harness']).toMatchObject({ provider: 'anthropic', frontend: 'claude-code' })
    expect(json['resolution']).toMatchObject({ source: 'wrkq-registry' })
    expect(json['release']).toMatchObject({ releaseId: 'asp-test-1' })
  })

  test('malformed scope refuses with a typed 400', async () => {
    boot()
    const { status, json } = await post({ cwd: root })

    expect(status).toBe(400)
    expect(json).toMatchObject({ error: { code: 'malformed_request' } })
  })

  test('unresolvable explicit project refuses with a typed 422', async () => {
    boot()
    const { status, json } = await post({
      agentId: 'smokey',
      projectId: 'no-such-project',
      projectOrigin: 'explicit',
      cwd: root,
      registryProjects: [],
      projectSearchRoots: [join(root, 'empty')],
    })

    expect(status).toBe(422)
    expect(JSON.stringify(json)).toContain('project root unknown for no-such-project')
  })

  test('unconfigured aspd refuses with runtime_unavailable, never absence', async () => {
    savedAspdSocket = process.env['HRC_ASPD_SOCKET']
    Reflect.deleteProperty(process.env, 'HRC_ASPD_SOCKET')
    const { status, json } = await post({ agentId: 'smokey', cwd: root })

    expect(status).toBe(503)
    expect(json).toMatchObject({ error: { code: 'runtime_unavailable' } })
  })
})
