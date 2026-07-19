import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  EnsureAppSessionRequest,
  EnsureAppSessionResponse,
  HrcAppSessionSpec,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { ensureAppSessionFromBody } from '../app-session-handlers'
import { invalidateHostContext, rotateSessionContext } from '../runtime-control-handlers'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const NOW = '2026-07-19T12:00:00.000Z'
const APP_ID = 'hrc-cli'
const APP_SESSION_KEY = 't06530-rearm'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:t06530'
const PRIMING_PROMPT = 'Begin the assigned task from profile priming.'

type DispatchCall = {
  hostSessionId: string
  intent: HrcRuntimeIntent
  prompt: string
  runId: string | undefined
}

function primedSpec(): HrcAppSessionSpec {
  return {
    kind: 'harness',
    runtimeIntent: {
      placement: {
        agentRoot: '/tmp/agent',
        projectRoot: '/tmp/project',
        cwd: '/tmp/project',
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
        dryRun: true,
      },
      harness: {
        provider: 'anthropic',
        id: 'claude-code',
        interactive: true,
      },
      initialPrompt: PRIMING_PROMPT,
    },
  }
}

function seedManagedRuntime(
  db: HrcDatabase,
  spec: HrcAppSessionSpec
): {
  session: HrcSessionRecord
  runtime: HrcRuntimeSnapshot
} {
  const session: HrcSessionRecord = {
    hostSessionId: 'hsid-t06530-old',
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  }
  db.sessions.insert(session)
  db.continuities.upsert({
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    activeHostSessionId: session.hostSessionId,
    updatedAt: NOW,
  })
  db.appManagedSessions.create({
    appId: APP_ID,
    appSessionKey: APP_SESSION_KEY,
    kind: 'harness',
    activeHostSessionId: session.hostSessionId,
    generation: session.generation,
    status: 'active',
    lastAppliedSpec: spec,
    createdAt: NOW,
    updatedAt: NOW,
  })

  db.runtimes.insert({
    runtimeId: 'rt-t06530-old',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    tmuxJson: {
      socketPath: '/tmp/tmux-t06530.sock',
      sessionName: 'tmux-t06530-old',
      sessionId: '$1',
      windowId: '@1',
      paneId: '%1',
    },
    supportsInflightInput: true,
    adopted: false,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const runtime = db.runtimes.getByRuntimeId('rt-t06530-old')
  if (!runtime) throw new Error('failed to seed prior runtime')

  return { session, runtime }
}

function makeHandlerInstance(db: HrcDatabase): {
  instance: HrcServerInstanceForHandlers
  dispatchCalls: DispatchCall[]
  provisionedHostSessionIds: string[]
  terminatedTmuxSessions: string[]
} {
  const dispatchCalls: DispatchCall[] = []
  const provisionedHostSessionIds: string[] = []
  const terminatedTmuxSessions: string[] = []
  const liveTmuxSessions = new Set(['tmux-t06530-old', '$1'])

  const instance = {
    db,
    tmux: {
      inspectSession: async (sessionName: string) =>
        liveTmuxSessions.has(sessionName) ? { sessionName } : null,
      terminate: async (sessionName: string) => {
        terminatedTmuxSessions.push(sessionName)
        liveTmuxSessions.delete(sessionName)
      },
    },
    invalidateHostContext,
    notifyEvent: () => {},
    ensureRuntimeForSession: async (
      session: HrcSessionRecord,
      _intent: HrcRuntimeIntent
    ): Promise<HrcRuntimeSnapshot> => {
      provisionedHostSessionIds.push(session.hostSessionId)
      const runtimeId = `rt-t06530-generation-${session.generation}`
      db.runtimes.insert({
        runtimeId,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        tmuxJson: {
          socketPath: '/tmp/tmux-t06530.sock',
          sessionName: `tmux-t06530-generation-${session.generation}`,
          sessionId: `$${session.generation}`,
          windowId: `@${session.generation}`,
          paneId: `%${session.generation}`,
        },
        supportsInflightInput: true,
        adopted: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      if (!runtime) throw new Error(`failed to provision ${runtimeId}`)
      return runtime
    },
    dispatchTurnForSession: async (
      session: HrcSessionRecord,
      intent: HrcRuntimeIntent,
      prompt: string,
      options: { runId?: string | undefined }
    ): Promise<Response> => {
      dispatchCalls.push({
        hostSessionId: session.hostSessionId,
        intent,
        prompt,
        runId: options.runId,
      })
      return new Response('{}', { status: 200 })
    },
  } as unknown as HrcServerInstanceForHandlers

  return { instance, dispatchCalls, provisionedHostSessionIds, terminatedTmuxSessions }
}

async function withDatabase(fn: (db: HrcDatabase) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-new-session-autobegin-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  try {
    await fn(db)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

describe('promptless managed-session re-arm auto-begin', () => {
  it('auto-dispatches stored priming after clear-context rotates the live runtime', async () => {
    await withDatabase(async (db) => {
      const spec = primedSpec()
      const { session, runtime } = seedManagedRuntime(db, spec)
      const { instance, dispatchCalls, provisionedHostSessionIds, terminatedTmuxSessions } =
        makeHandlerInstance(db)
      const managed = db.appManagedSessions.findByKey(APP_ID, APP_SESSION_KEY)
      if (!managed) throw new Error('failed to seed managed session')

      const rotated = await rotateSessionContext.call(instance, session, {
        relaunch: false,
        dropContinuation: true,
        managed,
      })

      expect(rotated.priorHostSessionId).toBe(session.hostSessionId)
      expect(rotated.hostSessionId).not.toBe(session.hostSessionId)
      expect(rotated.generation).toBe(2)
      expect(terminatedTmuxSessions).toEqual(['tmux-t06530-old'])
      expect(db.runtimes.getByRuntimeId(runtime.runtimeId)?.status).toBe('terminated')

      const ensureRequest = {
        selector: { appId: APP_ID, appSessionKey: APP_SESSION_KEY },
        spec,
      } satisfies EnsureAppSessionRequest
      expect(Object.hasOwn(ensureRequest, 'initialPrompt')).toBe(false)

      const response = await ensureAppSessionFromBody.call(instance, ensureRequest)
      const body = (await response.json()) as EnsureAppSessionResponse

      expect(body.created).toBe(false)
      expect(body.runtimeId).toBe('rt-t06530-generation-2')
      expect(provisionedHostSessionIds).toEqual([rotated.hostSessionId])
      expect(dispatchCalls).toHaveLength(1)
      expect(dispatchCalls[0]).toMatchObject({
        hostSessionId: rotated.hostSessionId,
        prompt: '',
        intent: { initialPrompt: PRIMING_PROMPT },
      })
      expect(dispatchCalls[0]?.runId).toMatch(/^run-/)
    })
  })

  it('does not re-dispatch a promptless idempotent ensure of an already-live runtime', async () => {
    await withDatabase(async (db) => {
      const spec = primedSpec()
      const { runtime } = seedManagedRuntime(db, spec)
      const { instance, dispatchCalls, provisionedHostSessionIds } = makeHandlerInstance(db)
      const ensureRequest = {
        selector: { appId: APP_ID, appSessionKey: APP_SESSION_KEY },
        spec,
      } satisfies EnsureAppSessionRequest

      const response = await ensureAppSessionFromBody.call(instance, ensureRequest)
      const body = (await response.json()) as EnsureAppSessionResponse

      expect(body.created).toBe(false)
      expect(body.runtimeId).toBe(runtime.runtimeId)
      expect(provisionedHostSessionIds).toHaveLength(0)
      expect(dispatchCalls).toHaveLength(0)
    })
  })
})
