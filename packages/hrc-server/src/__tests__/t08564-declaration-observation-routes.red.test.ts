/**
 * T-08564 Phase A route reds. The daemon is real and the ASP producer double
 * speaks NDJSON JSON-RPC over a real Unix socket. Before implementation every
 * case must collect and fail at the HTTP status assertion because both public
 * routes are absent; after implementation the later assertions pin projection,
 * forwarding, admission failures, and the preview's one-connection boundary.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { type HrcServer, createHrcServer } from '../index'
import {
  type AspdObservationDouble,
  type AspdObservationOptions,
  startAspdObservationDouble,
} from './fixtures/aspd-observation-doubles'
import { type Release, makeRelease } from './fixtures/aspd-route-doubles'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let aspd: AspdObservationDouble | undefined
let release: Release
let aspdSocket: string
let savedAspdSocket: string | undefined
let agentRoot: string
let projectRoot: string
let agentsRoot: string
let aspHome: string

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08564-routes-')
  aspdSocket = join(fixture.tmpDir, 'aspd.sock')
  release = makeRelease(join(fixture.tmpDir, 'releases'), 't08564')
  agentRoot = join(fixture.tmpDir, 'agents', 'smokey')
  projectRoot = join(fixture.tmpDir, 'project')
  agentsRoot = join(fixture.tmpDir, 'agents')
  aspHome = join(fixture.tmpDir, 'asp-home')
  await Promise.all([
    mkdir(agentRoot, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(aspHome, { recursive: true }),
  ])
  savedAspdSocket = process.env['HRC_ASPD_SOCKET']
})

afterEach(async () => {
  await server?.stop()
  aspd?.stop()
  server = undefined
  aspd = undefined
  if (savedAspdSocket === undefined) Reflect.deleteProperty(process.env, 'HRC_ASPD_SOCKET')
  else process.env['HRC_ASPD_SOCKET'] = savedAspdSocket
  await fixture.cleanup()
})

async function boot(options: AspdObservationOptions = {}) {
  aspd = startAspdObservationDouble(aspdSocket, release, options)
  process.env['HRC_ASPD_SOCKET'] = aspdSocket
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
}

function resolveRequest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'smokey',
    agentRoot,
    projectRoot,
    cwd: projectRoot,
    runMode: 'task',
    interactive: false,
    preferredMode: 'nonInteractive',
    allowInteractiveSurfaceReuse: false,
    provision: { model: 'x' },
    agentSources: { agentsRoot, aspHome },
    ...overrides,
  }
}

function managedIntent() {
  return {
    placement: {
      agentRoot,
      projectRoot,
      cwd: projectRoot,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
    execution: { preferredMode: 'headless' },
    provision: { model: 'x' },
  }
}

async function post(path: string, body: unknown): Promise<{ response: Response; body: any }> {
  const response = await fixture.postJson(path, body)
  const text = await response.text()
  let parsed: unknown = {}
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
  }
  return { response, body: parsed }
}

function requestParams(double: AspdObservationDouble, method: string): Record<string, unknown> {
  const request = double.connections
    .flatMap((connection) => connection.requests)
    .find((candidate) => candidate.method === method)
  expect(request, `${method} should reach the aspd double`).toBeDefined()
  return request!.params
}

describe('POST /v1/declarations/resolve (T-08564 Phase A red)', () => {
  test('forwards declaration context but does not reissue producer selection as an HRC request', async () => {
    await boot()
    const { response, body } = await post('/v1/declarations/resolve', resolveRequest())

    expect(response.status).toBe(200)
    expect(body.intent.harness).toEqual({ interactive: false })
    expect(body.intent).not.toHaveProperty('selection')
    expect(body.intent).not.toHaveProperty('provision')
    expect(body.declaration.agentSources).toEqual({
      agentsRoot,
      aspHome,
      provenance: 'caller-agent-root',
    })
    const params = requestParams(aspd!, 'aspc.resolveRuntimeDeclaration')
    expect(params['context']).toMatchObject({
      project: { mode: 'root', projectRoot },
      agentSources: { agentsRoot, aspHome },
    })
  })

  test('uses explicit project mode none and returns no projectRoot when it was omitted', async () => {
    await boot()
    const input = resolveRequest({ projectRoot: undefined })
    const { response, body } = await post('/v1/declarations/resolve', input)

    expect(response.status).toBe(200)
    expect(body.intent.placement).not.toHaveProperty('projectRoot')
    const params = requestParams(aspd!, 'aspc.resolveRuntimeDeclaration')
    expect((params['context'] as Record<string, unknown>)['project']).toEqual({
      mode: 'none',
    })
  })

  test('maps configured_context_mismatch to malformed_request without fallback', async () => {
    await boot({ resolve: 'incompatible' })
    const { response, body } = await post('/v1/declarations/resolve', resolveRequest())

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('malformed_request')
    expect(body.error.detail.code).toBe('configured_context_mismatch')
  })

  test('maps invalid project targets to declaration_invalid with producer diagnostics', async () => {
    await boot({ resolve: 'invalid' })
    const { response, body } = await post('/v1/declarations/resolve', resolveRequest())

    expect(response.status).toBe(422)
    expect(body.error.code).toBe('declaration_invalid')
    expect(body.error.detail).toMatchObject({
      source: 'project-targets',
      producerCode: 'project_targets_invalid',
    })
  })

  test('reports an absent aspd socket as a typed 503 rather than declaration absence', async () => {
    await boot({ socketAbsent: true })
    const { response, body } = await post('/v1/declarations/resolve', resolveRequest())

    expect(response.status).toBe(503)
    expect(body.error.code).toBe('runtime_unavailable')
    expect(body.error.detail).toMatchObject({
      code: 'aspd_unavailable',
      route: 'aspd',
    })
  })

  test('fails closed when resolveRuntimeDeclaration is not advertised', async () => {
    await boot({ capabilities: { resolveRuntimeDeclaration: false } })
    const { response, body } = await post('/v1/declarations/resolve', resolveRequest())

    expect(response.status).toBe(503)
    expect(body.error.detail.code).toBe('aspd_capability_missing')
  })

  test('fails closed when aspd advertises an incompatible protocol', async () => {
    await boot({ protocolVersion: 'aspc/999' })
    const { response, body } = await post('/v1/declarations/resolve', resolveRequest())

    expect(response.status).toBe(503)
    expect(body.error.detail.code).toBe('aspd_protocol_incompatible')
  })

  test('keeps target-only intent but emits the HRC-owned invalid-profile warning', async () => {
    await boot({ invalidAgentProfile: true })
    const { response, body } = await post('/v1/declarations/resolve', resolveRequest())

    expect(response.status).toBe(200)
    expect(body.declaration.warnings).toHaveLength(1)
    expect(body.declaration.warnings[0]).toStartWith(
      '[hrc-core] WARN agent.provisioning.stripped — agent "smokey"'
    )
    expect(body.declaration.warnings[0]).toContain(' error=')
  })
})

describe('invalid profile with no valid target (T-08564 E1, T-08578 etag 10; activation #8 capture)', () => {
  for (const variant of [
    {
      name: 'projectless (project mode none)',
      overrides: { projectRoot: undefined },
    },
    { name: 'project root without a selected target', overrides: {} },
  ]) {
    test(`${variant.name}: birth proceeds with no harness id, no provision block, and the NO-provisioning WARN`, async () => {
      await boot({ invalidAgentProfileNoTarget: true })
      const { response, body } = await post(
        '/v1/declarations/resolve',
        resolveRequest({ ...variant.overrides, provision: undefined })
      )

      expect(response.status).toBe(200)
      // A degraded observation cannot grant HRC a selection authority either.
      expect(body.intent.harness).toEqual({ interactive: false })
      expect(body.intent).not.toHaveProperty('provision')
      expect(body.declaration.warnings).toHaveLength(1)
      expect(body.declaration.warnings[0]).toContain(
        'is being born with NO provisioning at all: no model pin, no harness pin, no yolo, no node'
      )
      expect(body.declaration.warnings[0]).toContain(
        `profile=${agentRoot}/agent-profile.toml error=`
      )
    })
  }
})

describe('caller agent root without a profile (T-08564 E1, activation #8 capture)', () => {
  test("refuses with today's agent-install-incomplete text instead of birthing an undeclared agent", async () => {
    await boot({ absentAgentProfile: true })
    const { response, body } = await post(
      '/v1/declarations/resolve',
      resolveRequest({ projectRoot: undefined, provision: undefined })
    )

    expect(response.status).toBe(422)
    expect(body.error.code).toBe('declaration_invalid')
    expect(body.error.message).toBe(
      `buildRuntimeBundleRef: agent-profile.toml not found at ${agentRoot}/agent-profile.toml — agent install incomplete`
    )
    expect(body.error.detail).toMatchObject({ source: 'agent-profile' })
  })

  // Astra ruling (EN-14187): a missing caller root stays on the approved context
  // boundary. The producer's configured_context_mismatch is a 400 carrying the
  // producer message; HRC neither string-matches ENOENT nor stats the root to
  // restore today's agent-install-incomplete 422. This status and text differ
  // from today by that ruling.
  test('a nonexistent caller root keeps the approved context-mismatch mapping, not the install-incomplete refusal', async () => {
    const missingRoot = join(agentsRoot, 't08564-no-such-agent')
    await boot({ nonexistentAgentRoot: true })
    const { response, body } = await post(
      '/v1/declarations/resolve',
      resolveRequest({
        agentId: 't08564-no-such-agent',
        agentRoot: missingRoot,
        projectRoot: undefined,
        provision: undefined,
      })
    )

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('malformed_request')
    expect(body.error.message).toBe(`ENOENT: no such file or directory, stat '${missingRoot}'`)
    expect(body.error.detail).toEqual({
      code: 'configured_context_mismatch',
      route: 'aspd',
      operation: 'resolveRuntimeDeclaration',
    })
    expect(body.error.message).not.toContain('agent install incomplete')
  })
})

describe('POST /v1/previews/run (T-08564 Phase A red)', () => {
  const previewBody = () => ({
    intent: managedIntent(),
    sessionRef: 'agent:smokey:project:hrc-runtime:task:T-08564',
    restartStyle: 'fresh',
  })

  test('compiles and inspects on one admitted connection and names that release', async () => {
    await boot()
    const { response, body } = await post('/v1/previews/run', previewBody())

    expect(response.status).toBe(200)
    expect(aspd!.connections).toHaveLength(1)
    const methods = aspd!.connections[0]!.methods
    expect(methods.filter((method) => method === 'aspc.hello')).toHaveLength(1)
    expect(methods).toContain('aspc.compileHarnessInvocation')
    expect(methods).toContain('aspc.inspectRuntimePlacement')
    expect(JSON.stringify(body)).toContain(release.releaseId)
    expect(body.diagnostics).toMatchObject({
      releases: {
        aspd: {
          releaseId: release.releaseId,
          sourceCommit: release.sourceCommit,
        },
      },
      ids: { compileId: 'compile_t08564' },
      phases: [
        { id: 'compile', status: 'ok' },
        { id: 'admission', status: 'ok' },
        { id: 'inspect-prompt', status: 'ok' },
      ],
    })
  })

  // Astra EN-14276 (G1 audit A1/A6): the inspection context names the same
  // project and effective directives the compile sees. The project id comes from
  // the session scope and differs from the project directory basename; the
  // directive harness differs from the double's claude-code profile.
  test('inspects with the scope project id and the authorized provision directives the compile uses', async () => {
    await boot()
    const intent = {
      ...managedIntent(),
      provision: { harness: 'codex', model: 'x', yolo: true },
    }
    const { response } = await post('/v1/previews/run', {
      intent,
      sessionRef: 'agent:smokey:project:hrc-runtime:task:T-08564/lane:main',
      restartStyle: 'fresh',
    })

    expect(response.status).toBe(200)
    expect(projectRoot.split('/').at(-1)).not.toBe('hrc-runtime')
    const context = requestParams(aspd!, 'aspc.inspectRuntimePlacement')['context'] as Record<
      string,
      unknown
    >
    expect(context['project']).toEqual({
      mode: 'root',
      projectRoot,
      projectId: 'hrc-runtime',
    })
    expect(context['provisionDirectives']).toEqual({
      harness: 'codex',
      model: 'x',
    })
    expect(context['taskId']).toBe('T-08564')
  })

  // PC-1 (ACCEPTANCE PC-1; T-08579 PROPOSAL §8.4; SPEC §8 as amended C-23662):
  // inspection carries the compiled placement correlation, and the identical
  // dispatchEnv (inert), only on a connection advertising the capability.
  test('PC-1: inspection carries the compiled correlation and dispatchEnv when the capability is advertised', async () => {
    await boot({
      capabilities: { inspectRuntimePlacementPreparationCorrelation: true },
    })
    const correlation = {
      sessionRef: {
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-08564',
        laneRef: 'main',
      },
    }
    const dispatchEnv = { T08564_PC1_PROBE: 'caller-value' }
    const base = managedIntent()
    const { response } = await post('/v1/previews/run', {
      intent: {
        ...base,
        placement: { ...base.placement, correlation, dispatchEnv },
      },
      sessionRef: 'agent:smokey:project:hrc-runtime:task:T-08564/lane:main',
      restartStyle: 'fresh',
    })

    expect(response.status).toBe(200)
    const compileParams = requestParams(aspd!, 'aspc.compileHarnessInvocation')
    const compiledPlacement = (compileParams['compileRequest'] as Record<string, unknown>)[
      'placement'
    ] as Record<string, unknown>
    const inspectParams = requestParams(aspd!, 'aspc.inspectRuntimePlacement')
    expect(inspectParams['preparationCorrelation']).toEqual(compiledPlacement['correlation'])
    expect(inspectParams['preparationCorrelation']).toEqual(correlation)
    expect(inspectParams['dispatchEnv']).toEqual(compiledPlacement['dispatchEnv'])
    expect(inspectParams['dispatchEnv']).toEqual(dispatchEnv)
    expect(aspd!.connections).toHaveLength(1)
  })

  test('PC-1: a connection without the capability refuses the preview instead of omitting the correlation', async () => {
    await boot({
      capabilities: {
        inspectRuntimePlacementPreparationCorrelation: undefined,
      },
    })
    const { response, body } = await post('/v1/previews/run', previewBody())

    expect(response.status).toBe(503)
    expect(body.error.code).toBe('runtime_unavailable')
    expect(body.error.detail).toMatchObject({
      code: 'aspd_capability_missing',
      route: 'aspd',
    })
    const methods = aspd!.connections.flatMap((connection) => connection.methods)
    expect(methods).not.toContain('aspc.inspectRuntimePlacement')
  })

  test('omits prompt zones and failure fields for an absent prompt', async () => {
    await boot({ prompt: 'absent' })
    const { response, body } = await post('/v1/previews/run', previewBody())

    expect(response.status).toBe(200)
    expect(body).not.toHaveProperty('systemPrompt')
    expect(body).not.toHaveProperty('reminderContent')
    expect(body).not.toHaveProperty('promptResolution')
  })

  test('keeps plan fields and diagnostics but no zones for an invalid prompt', async () => {
    await boot({ prompt: 'invalid' })
    const { response, body } = await post('/v1/previews/run', previewBody())

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      controllerKind: 'harness-broker',
      promptResolution: {
        state: 'invalid',
        code: 'prompt_resolution_failed',
      },
    })
    expect(body).not.toHaveProperty('systemPrompt')
    expect(body).not.toHaveProperty('reminderContent')
  })

  test('reports an aspd outage as typed 503 without an in-process preview fallback', async () => {
    await boot()
    aspd!.stop()
    const { response, body } = await post('/v1/previews/run', previewBody())

    expect(response.status).toBe(503)
    expect(body.error.code).toBe('runtime_unavailable')
    expect(body.error.detail).toMatchObject({
      code: 'aspd_unavailable',
      route: 'aspd',
    })
  })

  test('returns a typed rejection with phase records instead of null', async () => {
    await boot({ compileRejected: true })
    const { response, body } = await post('/v1/previews/run', previewBody())

    expect(response.status).toBe(503)
    expect(body.error).toMatchObject({
      code: 'runtime_unavailable',
      detail: {
        code: 'compile-not-ok',
        admissionCode: 'compile-not-ok',
        failingPhase: 'admission',
        aspdRelease: { releaseId: release.releaseId },
        phases: [
          { id: 'compile', status: 'ok' },
          { id: 'admission', status: 'error' },
        ],
      },
    })
  })

  test('fails truthfully when prompt inspection is unavailable', async () => {
    await boot({ inspectNonOk: true })
    const { response, body } = await post('/v1/previews/run', previewBody())

    expect(response.status).toBe(503)
    expect(body.error.detail).toMatchObject({
      code: 'prompt-inspection-unavailable',
      failingPhase: 'inspect-prompt',
    })
  })
})
