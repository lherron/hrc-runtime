import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcActuatorSplitPolicy, HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'

import {
  actuatorSplitRuntimeAuthority,
  assertActuatorSplitAdmission,
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
  prepareActuatorSplitIntent,
} from '../actuator-split'
import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

const ZERO_HASH = '0'.repeat(64)

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function verifierPolicy(): HrcActuatorSplitPolicy {
  return {
    schemaVersion: 'hrc.actuator-split-policy/v1',
    mode: 'high-risk',
    workflowRef: 'wrkf:test',
    laneClass: 'verifier',
    codeMutation: 'forbidden',
    productionCodePaths: ['packages'],
  }
}

function intent(
  workspaceRoot: string,
  actuatorSplit: HrcActuatorSplitPolicy,
  launchEnv?: Record<string, string>
): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: workspaceRoot,
      projectRoot: workspaceRoot,
      cwd: workspaceRoot,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
    execution: {
      preferredMode: 'headless',
      allowInteractiveSurfaceReuse: false,
      actuatorSplit,
    },
    ...(launchEnv ? { launch: { env: launchEnv } } : {}),
    initialPrompt: 'free-form caller prompt',
  }
}

function startRequest(
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
): InvocationStartRequest {
  return {
    spec: {
      specVersion: 'harness-broker.invocation/v1',
      invocationId: 'inv-t05439',
      harness: {
        frontend: 'codex',
        provider: 'openai',
        driver: 'codex-app-server',
      },
      process: {
        command: 'codex',
        args: ['app-server'],
        cwd: '/tmp/t05439',
        lockedEnv: {},
        harnessTransport: { kind: 'jsonrpc-stdio' },
      },
      interaction: { mode: 'headless', turnConcurrency: 'single' },
      driver: {
        kind: 'codex-app-server',
        sandboxMode,
        approvalPolicy: 'never',
      },
    },
  }
}

async function run(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(args, {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${args.join(' ')} failed: ${stderr}`)
  return stdout.trim()
}

describe('T-05439 direct actuator-split admission', () => {
  it('admits only a hash-covered read-only codex app-server for verifier lanes', async () => {
    const runtimeIntent = intent('/tmp/t05439', verifierPolicy())

    await expect(
      assertActuatorSplitAdmission({
        intent: runtimeIntent,
        route: 'broker',
        startRequest: startRequest('read-only'),
      })
    ).resolves.toMatchObject({
      actuatorSplit: { laneClass: 'verifier', codeMutation: 'forbidden' },
    })

    await expect(
      assertActuatorSplitAdmission({
        intent: runtimeIntent,
        route: 'broker',
        startRequest: startRequest('workspace-write'),
      })
    ).rejects.toThrow('high-risk-verifier-requires-read-only-codex-app-server')

    expect(() => assertActuatorSplitRouteAdmission(runtimeIntent, 'sdk')).toThrow(
      'high-risk-route-requires-headless-codex-broker'
    )
    for (const harness of [
      { provider: 'anthropic', id: 'claude-code', interactive: false },
      { provider: 'openai', id: 'pi', interactive: false },
    ] as const) {
      expect(() =>
        assertActuatorSplitRouteAdmission({ ...runtimeIntent, harness }, 'broker')
      ).toThrow('high-risk-route-requires-headless-codex-broker')
    }
  })

  it('strips caller credential env for read-only lanes without overriding locked env', async () => {
    const prepared = await prepareActuatorSplitIntent(
      intent('/tmp/t05439', verifierPolicy(), {
        SAFE_VALUE: 'kept',
        GITHUB_TOKEN: 'discarded',
        SERVICE_PASSWORD: 'discarded-too',
      })
    )

    expect(prepared.intent.launch?.env).toEqual({ SAFE_VALUE: 'kept' })
    expect(prepared.intent.launch?.unsetEnv).toEqual(
      expect.arrayContaining(['GITHUB_TOKEN', 'SERVICE_PASSWORD'])
    )
  })

  it('rejects reuse when the persisted runtime authority is absent or different', () => {
    const runtimeIntent = intent('/tmp/t05439', verifierPolicy())
    const runtime = {
      runtimeId: 'rt-t05439-old',
      runtimeKind: 'harness',
      hostSessionId: 'hsid-t05439',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-05439',
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    } as const

    expect(() => assertActuatorSplitRuntimeReuse(runtimeIntent, runtime)).toThrow(
      'runtime-actuator-split-authority-mismatch'
    )
    expect(() =>
      assertActuatorSplitRuntimeReuse(runtimeIntent, {
        ...runtime,
        runtimeStateJson: { authority: { actuatorSplit: verifierPolicy() } },
      })
    ).not.toThrow()
  })

  it('rejects the verifier-found bogus approval/artifact/base case before launch', async () => {
    const policy: HrcActuatorSplitPolicy = {
      schemaVersion: 'hrc.actuator-split-policy/v1',
      mode: 'high-risk',
      laneClass: 'actuator',
      codeMutation: 'apply-approved-artifact',
      productionCodePaths: ['packages'],
      approval: {
        schemaVersion: 'hrc.approved-mutation-ref/v1',
        source: 'manual-operator',
        approvalRef: `file:///definitely/missing/t05439-approval.json#sha256:${ZERO_HASH}`,
        artifactRef: 'file:///definitely/missing/t05439.patch',
        artifactKind: 'git-apply-patch',
        targetPaths: ['packages/target.txt'],
        expectedBaseRevision: 'bogus-base-revision',
        artifactContentHash: `sha256:${ZERO_HASH}`,
      },
    }

    await expect(
      assertActuatorSplitAdmission({
        intent: intent('/tmp', policy),
        route: 'broker',
        startRequest: startRequest('workspace-write'),
      })
    ).rejects.toThrow('unresolvable-local-file-ref')
  })

  it('resolves an immutable approval, verifies clean base and paths, and replaces free-form input', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hrc-t05439-direct-'))
    try {
      await mkdir(join(workspace, 'packages'), { recursive: true })
      await Bun.write(join(workspace, 'packages', 'target.txt'), 'before\n')
      await run(workspace, ['git', 'init'])
      await run(workspace, ['git', 'config', 'user.email', 't05439@example.test'])
      await run(workspace, ['git', 'config', 'user.name', 'T05439 Test'])
      await run(workspace, ['git', 'add', 'packages/target.txt'])
      await run(workspace, ['git', 'commit', '-m', 'base'])
      const baseRevision = await run(workspace, ['git', 'rev-parse', 'HEAD'])
      const baseTree = await run(workspace, ['git', 'rev-parse', 'HEAD^{tree}'])

      await Bun.write(join(workspace, 'packages', 'target.txt'), 'after\n')
      const patch = await run(workspace, ['git', 'diff', '--binary'])
      await Bun.write(join(workspace, 'packages', 'target.txt'), 'before\n')
      const artifactPath = join(workspace, 'approved.patch')
      await Bun.write(artifactPath, `${patch}\n`)
      const artifactContent = await Bun.file(artifactPath).text()
      const artifactHash = hash(artifactContent)
      const artifactRef = pathToFileURL(artifactPath).href
      const approvalRecord = {
        schemaVersion: 'hrc.approved-mutation-approval/v1',
        source: 'manual-operator',
        artifactRef,
        artifactKind: 'git-apply-patch',
        artifactContentHash: `sha256:${artifactHash}`,
        targetPaths: ['packages/target.txt'],
        expectedBaseRevision: baseRevision,
        expectedBaseTreeHash: baseTree,
        approvedBy: 'human:lance',
        approvedAt: '2026-07-25T00:00:00.000Z',
      }
      const approvalContent = `${JSON.stringify(approvalRecord, null, 2)}\n`
      const approvalPath = join(workspace, 'approval.json')
      await Bun.write(approvalPath, approvalContent)
      const approvalUrl = pathToFileURL(approvalPath)
      approvalUrl.hash = `sha256:${hash(approvalContent)}`

      const policy: HrcActuatorSplitPolicy = {
        schemaVersion: 'hrc.actuator-split-policy/v1',
        mode: 'high-risk',
        laneClass: 'actuator',
        codeMutation: 'apply-approved-artifact',
        productionCodePaths: ['packages'],
        approval: {
          schemaVersion: 'hrc.approved-mutation-ref/v1',
          source: 'manual-operator',
          approvalRef: approvalUrl.href,
          artifactRef,
          artifactKind: 'git-apply-patch',
          targetPaths: ['packages/target.txt'],
          expectedBaseRevision: baseRevision,
          expectedBaseTreeHash: baseTree,
          artifactContentHash: `sha256:${artifactHash}`,
        },
      }

      const prepared = await prepareActuatorSplitIntent(intent(workspace, policy))
      expect(prepared.intent.initialPrompt).toContain('HRC deterministic actuator request')
      expect(prepared.intent.initialPrompt).not.toContain('free-form caller prompt')
      expect(prepared.intent.initialPrompt).toContain('packages/target.txt')

      const reusedTurn = await prepareActuatorSplitIntent({
        ...prepared.intent,
        initialPrompt: 'second free-form prompt sent to a matching actuator runtime',
      })
      expect(reusedTurn.intent.initialPrompt).toContain('HRC deterministic actuator request')
      expect(reusedTurn.intent.initialPrompt).not.toContain('second free-form prompt')

      const admitted = await assertActuatorSplitAdmission({
        intent: prepared.intent,
        route: 'broker',
        startRequest: startRequest('workspace-write'),
        preparedAuthority: prepared.authority,
      })
      expect(actuatorSplitRuntimeAuthority(admitted)).toMatchObject({
        actuatorSplit: { laneClass: 'actuator' },
        approvedMutation: {
          artifactContentHash: `sha256:${artifactHash}`,
          targetPaths: ['packages/target.txt'],
          expectedBaseRevision: baseRevision,
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('T-05439 live /v1/turns pre-launch rejection', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t05439-live-')
    server = await createHrcServer(
      fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
    )
  })

  afterEach(async () => {
    await server?.stop()
    server = undefined
    await fixture.cleanup()
  })

  it('rejects bogus approval evidence before any runtime or broker start graph exists', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-05439'
    const { hostSessionId } = await fixture.resolveSession(scopeRef)
    const policy: HrcActuatorSplitPolicy = {
      schemaVersion: 'hrc.actuator-split-policy/v1',
      mode: 'high-risk',
      laneClass: 'actuator',
      codeMutation: 'apply-approved-artifact',
      productionCodePaths: ['packages'],
      approval: {
        schemaVersion: 'hrc.approved-mutation-ref/v1',
        source: 'manual-operator',
        approvalRef: `file:///missing/t05439-approval.json#sha256:${ZERO_HASH}`,
        artifactRef: 'file:///missing/t05439.patch',
        artifactKind: 'git-apply-patch',
        targetPaths: ['packages/target.txt'],
        expectedBaseRevision: 'bogus-base-revision',
        artifactContentHash: `sha256:${ZERO_HASH}`,
      },
    }

    const response = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'free-form implementation text must never reach an actuator',
      runtimeIntent: intent(fixture.tmpDir, policy),
      waitFor: 'accepted',
    })
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; detail?: { reason?: string } }
    }

    expect(response.status).toBe(503)
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.detail?.reason).toBe('unresolvable-local-file-ref')

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.listByHostSessionId(hostSessionId)).toEqual([])
      expect(db.runs.listRuns({ hostSessionId })).toEqual([])
    } finally {
      db.close()
    }
  })
})
