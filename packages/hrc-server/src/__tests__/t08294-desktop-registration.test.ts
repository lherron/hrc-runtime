/**
 * T-08294 — permanent Stella scopes and external desktop thread attachment.
 *
 * Everything here is about a promise that has no expiry: the readable address a
 * desktop conversation is given is the address it keeps. So the tests are
 * mostly about what happens LATER — a second registration, a restart, an
 * ordinary roster press, a mail kick at a conversation nobody has touched.
 *
 * The `session_meta` fixtures are VERBATIM first records from real rollouts in
 * `~/.codex/sessions` (2026-09-08), with only `base_instructions.text` replaced
 * so the file stays readable. Nothing about them is invented, including the
 * detail that a guardian rollout's `session_id` names its PARENT conversation
 * while `id` names itself — a synthetic fixture would not have had that, and it
 * is the second fence under the admission rule.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcSessionRecord, WrkqProjectRegistryEntry } from 'hrc-core'
import type { DesktopThreadRegistration, HrcDatabase } from 'hrc-store-sqlite'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'

import {
  admitDesktopThread,
  canonicalPath,
  parseDesktopSessionMeta,
} from '../desktop/native-identity'
import {
  buildDesktopObserverPlan,
  markDesktopRuntimeExternallyOwned,
} from '../desktop/observer-attachment'
import { scheduleDesktopObserverAttachment } from '../desktop/observer-supervisor'
import { resolveDesktopProjectBinding } from '../desktop/project-binding'
import { type DesktopRegistrationResponse, registerDesktopThread } from '../desktop/registration'
import {
  allocateDesktopSlot,
  assertDesktopScopeNotColdBorn,
  desktopSlotTokens,
  isScopeReservedForDesktop,
} from '../desktop/scope-reservation'
import { appendEvent } from '../event-notification-handlers'
import { startExactScopeRuntime } from '../exact-claim'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle'
import { startSuffixRosterRuntime } from '../roster-claim'
import { invalidateHostContext, rotateSessionContext } from '../runtime-control-handlers'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

// --- real rollout headers -------------------------------------------------

const DESKTOP_THREAD = '01a08138-7d09-7e12-b8ba-d82b744d9a1e'
const GUARDIAN_THREAD = '01a0815c-627c-7fd3-ae09-f38591de193a'

function desktopMetaLine(sessionId: string, cwd: string): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: sessionId,
      timestamp: '2026-09-08T13:32:38.041Z',
      cwd,
      originator: 'Codex Desktop',
      cli_version: '0.153.3',
      source: 'vscode',
      thread_source: 'user',
      model_provider: 'openai',
      base_instructions: { text: '<trimmed for fixture>' },
    },
  })
}

/** A guardian review thread: object `source`, and `session_id` = the PARENT. */
const GUARDIAN_META_LINE = JSON.stringify({
  type: 'session_meta',
  payload: {
    session_id: DESKTOP_THREAD,
    id: GUARDIAN_THREAD,
    timestamp: '2026-09-08T14:11:50.538Z',
    cwd: '/Users/lherron/praesidium/clients/hrc-ios',
    originator: 'Codex Desktop',
    cli_version: '0.153.3',
    source: { subagent: { other: 'guardian' } },
    thread_source: 'guardian_review',
    model_provider: 'openai',
    base_instructions: { text: '<trimmed for fixture>' },
  },
})

/** A `harness-broker` CLI runtime: string `source`, but NO `thread_source`. */
const HARNESS_META_LINE = JSON.stringify({
  type: 'session_meta',
  payload: {
    session_id: '01a073c6-85a4-77c1-8156-009d9f33047c',
    id: '01a073c6-85a4-77c1-8156-009d9f33047c',
    timestamp: '2026-09-05T22:53:05.343Z',
    cwd: '/Users/lherron/praesidium/agent-spaces',
    originator: 'harness-broker',
    cli_version: '0.153.4',
    source: 'vscode',
    model_provider: 'openai',
    base_instructions: { text: '<trimmed for fixture>' },
  },
})

// --- harness --------------------------------------------------------------

type Harness = {
  instance: HrcServerInstanceForHandlers
  db: HrcDatabase
  /** Sessions the ORDINARY start path was asked to boot. Must stay empty for a desktop scope. */
  started: HrcSessionRecord[]
  /** Driver specs the observer attachment was asked to attach with. */
  attachments: Array<Record<string, unknown>>
}

function makeHarness(db: HrcDatabase): Harness {
  const started: HrcSessionRecord[] = []
  const attachments: Array<Record<string, unknown>> = []
  const instance = {
    db,
    options: {},
    runtimeStartOperations: new Map(),
    notifyEvent: () => {},
    appendEvent,
    invalidateHostContext,
    rotateSessionContext,
    startRuntimeForSession: (session: HrcSessionRecord, intent: HrcRuntimeIntent) => {
      // The real `startRuntimeForSession` calls `assertDesktopScopeNotColdBorn`
      // before anything else; replicate exactly that ordering so a test that
      // reaches this stub through the claim paths proves the fence, not the stub.
      assertDesktopScopeNotColdBorn(db, session.scopeRef)
      started.push(session)
      db.sessions.updateIntent(session.hostSessionId, intent, NOW)
      const runtimeId = `rt-${session.hostSessionId}`
      db.runtimes.insert({
        runtimeId,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        transport: 'headless',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      if (!runtime) throw new Error('failed to seed runtime')
      return Promise.resolve(runtime)
    },
    // Stands in for the broker controller round-trip. The scheduling contract —
    // when it is called, when it is NOT — is what these tests own; the real
    // invocation shape is asserted separately against the public validators.
    attachDesktopObserver: (input: { driver: Record<string, unknown> }) => {
      attachments.push(input.driver)
      return Promise.resolve({
        attached: false as const,
        reason: 'test_stub',
        detail: 'no broker in this fixture',
      })
    },
  } as unknown as HrcServerInstanceForHandlers
  return { instance, db, started, attachments }
}

const NOW = '2026-09-08T12:00:00.000Z'

/**
 * Let scheduled (deliberately un-awaited) attachment work settle.
 *
 * `scheduleDesktopObserverAttachment` returns a disposition, never a promise —
 * callers must not be able to wait on it — so tests drain the macrotask queue
 * instead. One `Promise.resolve()` is not enough: the attachment runs through a
 * `.then().catch().finally()` chain.
 */
async function settleAttachments(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let dir: string
let db: HrcDatabase
let harness: Harness
/** `<dir>/codex` — the desktop Codex home for these fixtures. */
let codexHome: string
/** `<dir>/praesidium` — mirrors the real nested/symlinked checkout topology. */
let praesidium: string
let bundleExecutable: string
let registryProjects: WrkqProjectRegistryEntry[]

async function writeRollout(threadId: string, line: string): Promise<string> {
  const day = join(codexHome, 'sessions', '2026', '09', '08')
  await mkdir(day, { recursive: true })
  const path = join(day, `rollout-2026-09-08T08-32-38-${threadId}.jsonl`)
  await writeFile(path, `${line}\n`)
  return path
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't08294-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  harness = makeHarness(db)
  codexHome = join(dir, 'codex')
  await mkdir(codexHome, { recursive: true })
  // A real file, so bundle resolution is deterministic instead of depending on
  // whether this host happens to have ChatGPT.app installed.
  bundleExecutable = join(dir, 'codex-bundle')
  await writeFile(bundleExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  // The real topology this task has to get right: a registered project whose
  // registry root is a SYMLINK into a nested directory, inside another
  // registered project that carries an `asp-targets.toml` marker.
  praesidium = join(dir, 'praesidium')
  await mkdir(join(praesidium, 'clients', 'hrc-ios', '.git'), {
    recursive: true,
  })
  await writeFile(join(praesidium, 'asp-targets.toml'), 'schema = 1\n')
  await symlink(join(praesidium, 'clients', 'hrc-ios'), join(praesidium, 'hrc-ios'))
  registryProjects = [
    { slug: 'praesidium', root: praesidium },
    { slug: 'hrc-ios', root: join(praesidium, 'hrc-ios') },
  ]
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

// --- admission ------------------------------------------------------------

describe('native admission', () => {
  it('admits the main desktop conversation', () => {
    const meta = parseDesktopSessionMeta(desktopMetaLine(DESKTOP_THREAD, '/w'))
    expect(meta?.sessionId).toBe(DESKTOP_THREAD)
    expect(admitDesktopThread(meta!).admitted).toBe(true)
  })

  it('refuses a guardian review thread on its object source', () => {
    const meta = parseDesktopSessionMeta(GUARDIAN_META_LINE)
    const admission = admitDesktopThread(meta!)
    expect(admission.admitted).toBe(false)
    expect(admission.admitted === false && admission.reason).toBe('spawned_subagent')
  })

  it('refuses a harness-broker CLI runtime that shares the desktop source string', () => {
    // The control that matters: `source: 'vscode'` alone is NOT a desktop
    // discriminator — 81 of 400 observed rollouts are CLI runtimes wearing it.
    const meta = parseDesktopSessionMeta(HARNESS_META_LINE)
    const admission = admitDesktopThread(meta!)
    expect(admission.admitted).toBe(false)
    expect(admission.admitted === false && admission.reason).toBe('non_user_thread')
  })
})

// --- project binding (T-07514 shape) --------------------------------------

describe('frozen project binding', () => {
  const bind = (workspaceCwd: string, env: Record<string, string | undefined> = {}) =>
    resolveDesktopProjectBinding({
      workspaceCwd,
      env: { HOME: dir, ...env },
      registryProjects,
      agentsRoot: join(dir, 'agents'),
    })

  it('binds a nested registered workspace to itself, not the enclosing project', () => {
    const result = bind(join(praesidium, 'clients', 'hrc-ios'))
    expect('bound' in result && result.bound.projectId).toBe('hrc-ios')
  })

  it('resolves the symlinked registry spelling to the same project', () => {
    // Registry says `<praesidium>/hrc-ios`; desktop reports
    // `<praesidium>/clients/hrc-ios`. Both must canonicalize to one project.
    const viaSymlink = bind(join(praesidium, 'hrc-ios'))
    const viaReal = bind(join(praesidium, 'clients', 'hrc-ios'))
    expect('bound' in viaSymlink && viaSymlink.bound.projectId).toBe('hrc-ios')
    expect('bound' in viaReal && viaReal.bound.projectRoot).toBe(
      'bound' in viaSymlink ? viaSymlink.bound.projectRoot : 'MISMATCH'
    )
  })

  it('still binds the enclosing project when the workspace IS its root', () => {
    // The control case. A rule that just prefers the deepest path string would
    // pass the test above and fail this one.
    const result = bind(praesidium)
    expect('bound' in result && result.bound.projectId).toBe('praesidium')
  })

  it('ignores an ambient ASP_PROJECT that disagrees with the workspace', () => {
    // The literal T-07514 observation was ASP_PROJECT=praesidium on an hrc-ios
    // workspace. Env is not evidence about a directory.
    const result = bind(join(praesidium, 'clients', 'hrc-ios'), {
      ASP_PROJECT: 'praesidium',
    })
    expect('bound' in result && result.bound.projectId).toBe('hrc-ios')
  })

  it('reports an unregistered nested boundary as pending rather than guessing', async () => {
    const worktree = join(praesidium, 'under-construction', 'cody-T-1-agent-spaces')
    await mkdir(join(worktree, '.git'), { recursive: true })
    const result = bind(worktree)
    expect('pending' in result && result.reason).toBe('project_ambiguous')
    expect('pending' in result && result.detail).toContain('wrkq set')
  })

  it('binds a real linked worktree to its registered repository, unless separately registered', async () => {
    const repo = join(praesidium, 'arris')
    const worktree = join(praesidium, 'under-construction', 'gui-prototype')
    await mkdir(repo, { recursive: true })
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args])
    git('init')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'init'
    )
    git('worktree', 'add', '-b', 'prototype', worktree)
    registryProjects.push({ slug: 'arris', root: repo })
    const result = bind(worktree)
    expect('bound' in result && result.bound.projectId).toBe('arris')
    expect('bound' in result && result.bound.projectRoot).toBe(canonicalPath(repo))
    registryProjects.push({ slug: 'gui-prototype', root: worktree })
    const separate = bind(worktree)
    expect('bound' in separate && separate.bound.projectId).toBe('gui-prototype')
  })
})

// --- allocation -----------------------------------------------------------

describe('permanent scope allocation', () => {
  const register = async (
    threadId: string,
    workspace: string,
    overrides: Record<string, unknown> = {}
  ): Promise<DesktopRegistrationResponse> => {
    const rolloutPath = await writeRollout(threadId, desktopMetaLine(threadId, workspace))
    return await registerDesktopThread.call(
      harness.instance,
      {
        nativeThreadId: threadId,
        codexHome,
        rolloutPath,
        bundleExecutable,
        hookSource: 'startup',
        ...overrides,
      },
      { registryProjects }
    )
  }

  it('gives two concurrent distinct threads distinct permanent addresses', async () => {
    const workspace = join(praesidium, 'clients', 'hrc-ios')
    const second = '01a08139-7d09-7e12-b8ba-d82b744d9a1f'
    const [a, b] = await Promise.all([
      register(DESKTOP_THREAD, workspace),
      register(second, workspace),
    ])
    expect(a.status).toBe('registered')
    expect(b.status).toBe('registered')
    const scopes = [a, b]
      .map((r) => (r.status === 'registered' ? r.cache.scopeRef : 'PENDING'))
      .sort()
    expect(scopes).toEqual([
      'agent:stella:project:hrc-ios:task:primary-comet',
      'agent:stella:project:hrc-ios:task:primary-nova',
    ])
  })

  it('returns the SAME address for a repeated registration of one thread', async () => {
    const workspace = join(praesidium, 'clients', 'hrc-ios')
    const first = await register(DESKTOP_THREAD, workspace)
    // A different hook source, a bundle upgrade and a moved workspace must all
    // be irrelevant: none of them is part of the registration key.
    const again = await register(DESKTOP_THREAD, praesidium, {
      hookSource: 'user-prompt-submit',
      bundleVersion: '0.199.0',
    })
    expect(first.status === 'registered' && first.created).toBe(true)
    expect(again.status === 'registered' && again.created).toBe(false)
    expect(again.status === 'registered' && again.cache.scopeRef).toBe(
      first.status === 'registered' ? first.cache.scopeRef : 'MISMATCH'
    )
    expect(again.status === 'registered' && again.cache.projectId).toBe('hrc-ios')
  })

  it('survives a daemon restart: the address is read back from the store', async () => {
    const workspace = join(praesidium, 'clients', 'hrc-ios')
    const first = await register(DESKTOP_THREAD, workspace)
    const scopeRef = first.status === 'registered' ? first.cache.scopeRef : 'PENDING'

    // Simulate a restart: drop every in-memory structure and reopen the store.
    db.close()
    db = openHrcDatabase(join(dir, 'state.sqlite'))
    harness = makeHarness(db)

    const after = await register(DESKTOP_THREAD, workspace)
    expect(after.status === 'registered' && after.cache.scopeRef).toBe(scopeRef)
    expect(after.status === 'registered' && after.created).toBe(false)
  })

  it('refuses a guardian thread without allocating a name', async () => {
    const rolloutPath = await writeRollout(GUARDIAN_THREAD, GUARDIAN_META_LINE)
    const result = await registerDesktopThread.call(harness.instance, {
      nativeThreadId: GUARDIAN_THREAD,
      codexHome,
      rolloutPath,
      hookSource: 'startup',
    })
    // TWO independent fences stand between a guardian rollout and a name, and
    // this asserts WHICH one fired: a guardian rollout's `session_id` names its
    // PARENT conversation, so the native-identity check rejects before
    // admission ever looks at `source`. (`admitDesktopThread` is covered
    // directly above, on the same fixture.)
    expect(result.status === 'pending' && result.reason).toBe('native_thread_mismatch')
    expect(db.desktopThreadRegistrations.listAll()).toHaveLength(0)
  })

  it('leaves registration pending when the rollout has not materialized yet', async () => {
    const result = await registerDesktopThread.call(harness.instance, {
      nativeThreadId: DESKTOP_THREAD,
      codexHome,
      rolloutPath: join(codexHome, 'sessions', 'missing.jsonl'),
      hookSource: 'startup',
    })
    expect(result.status === 'pending' && result.reason).toBe('native_metadata_unavailable')
    expect(db.desktopThreadRegistrations.listAll()).toHaveLength(0)
  })

  it('allocates more than ten names, rolling into numbered rounds', () => {
    // Pure allocator, no hooks: the >10 case the contract calls for, against the
    // real store's uniqueness constraints rather than a list in memory.
    const allocated: string[] = []
    for (let index = 0; index < 13; index += 1) {
      const slot = allocateDesktopSlot(db, 'stella', 'hrc-ios')
      db.desktopThreadRegistrations.insert({
        registrationKey: `key-${index}`,
        homeIdentity: codexHome,
        sqliteHome: codexHome,
        nativeThreadId: `01a08138-7d09-7e12-b8ba-d82b744d8${String(index).padStart(3, '0')}`,
        scopeRef: slot.scopeRef,
        agentId: 'stella',
        projectId: 'hrc-ios',
        slotToken: slot.slotToken,
        laneRef: 'main',
        hostSessionId: `hsid-${index}`,
        projectRoot: praesidium,
        workspaceCwd: praesidium,
        registeredVia: 'test',
        createdAt: NOW,
        updatedAt: NOW,
      })
      allocated.push(slot.slotToken)
    }
    expect(allocated).toEqual(desktopSlotTokens(13))
    expect(allocated.slice(0, 3)).toEqual(['primary-nova', 'primary-comet', 'primary-pulsar'])
    expect(allocated.slice(10)).toEqual(['primary-nova-2', 'primary-comet-2', 'primary-pulsar-2'])
    expect(allocated).not.toContain('primary')
    expect(new Set(allocated).size).toBe(13)
  })
})

// --- the reservation fence ------------------------------------------------

describe('ordinary allocators cannot recycle a desktop reservation', () => {
  const RESERVED = 'agent:stella:project:hrc-ios:task:primary-nova'

  function reserve(): void {
    db.desktopThreadRegistrations.insert({
      registrationKey: 'key-reserved',
      homeIdentity: codexHome,
      sqliteHome: codexHome,
      nativeThreadId: DESKTOP_THREAD,
      scopeRef: RESERVED,
      agentId: 'stella',
      projectId: 'hrc-ios',
      slotToken: 'primary-nova',
      laneRef: 'main',
      hostSessionId: 'hsid-reserved',
      projectRoot: praesidium,
      workspaceCwd: praesidium,
      registeredVia: 'test',
      createdAt: NOW,
      updatedAt: NOW,
    })
  }

  function intent(scopeRef: string): HrcRuntimeIntent {
    return {
      placement: {
        agentRoot: join(dir, 'agent'),
        projectRoot: praesidium,
        cwd: praesidium,
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
        dryRun: true,
        correlation: { sessionRef: { scopeRef, laneRef: 'main' } },
      },
      harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
      execution: { preferredMode: 'headless' },
      presentation: { viewerWindow: 'console' },
    } as HrcRuntimeIntent
  }

  /**
   * Occupy the bare base so a suffix press has to reach the suffixed slots and
   * can demonstrably step over — or onto — `primary-nova`.
   */
  function occupyBase(): void {
    db.continuities.upsert({
      scopeRef: 'agent:stella:project:hrc-ios:task:primary',
      laneRef: 'main',
      activeHostSessionId: 'hsid-base',
      updatedAt: NOW,
    })
    db.sessions.insert({
      hostSessionId: 'hsid-base',
      scopeRef: 'agent:stella:project:hrc-ios:task:primary',
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: 'rt-base',
      hostSessionId: 'hsid-base',
      scopeRef: 'agent:stella:project:hrc-ios:task:primary',
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  }

  const pressSuffix = async (key: string) =>
    (
      await startSuffixRosterRuntime.call(harness.instance, {
        baseSessionRef: 'agent:stella:project:hrc-ios:task:primary/lane:main',
        runtimeIntent: intent('agent:stella:project:hrc-ios:task:primary'),
        conflictPolicy: 'suffix',
        idempotencyKey: key,
      })
    ).claim

  it('CONTROL: with no reservation, the same press lands on primary-nova', async () => {
    // Without this control the skip test below proves nothing — `primary-comet`
    // could be where the press always lands.
    occupyBase()
    expect((await pressSuffix('control-press')).slot).toBe('primary-nova')
  })

  it('the suffix roster steps over a reserved slot to the next token', async () => {
    reserve()
    occupyBase()
    // Nothing makes the reserved slot look occupied to the ordinary FREE
    // predicate: no runtime, no in-flight start, no session was ever minted on
    // it. The reservation alone is what moves the press.
    expect((await pressSuffix('press-2')).slot).toBe('primary-comet')
    expect(isScopeReservedForDesktop(db, RESERVED)).toBe(true)
  })

  it('an exact claim on the reserved address is refused', async () => {
    reserve()
    let error: { code?: string; detail?: Record<string, unknown> } | undefined
    try {
      await startExactScopeRuntime.call(harness.instance, {
        sessionRef: `${RESERVED}/lane:main`,
        runtimeIntent: intent(RESERVED),
        conflictPolicy: 'reject',
        idempotencyKey: 'exact-1',
      })
    } catch (caught) {
      error = caught as { code?: string; detail?: Record<string, unknown> }
    }
    expect(error?.code).toBe('session_scope_occupied')
    expect(error?.detail?.['reservation']).toBe('codex-desktop')
    expect(harness.started).toHaveLength(0)
  })
})

// --- no cold birth, no desktop death --------------------------------------

describe('observer failure is not desktop death', () => {
  const RESERVED = 'agent:stella:project:hrc-ios:task:primary-nova'

  beforeEach(() => {
    db.desktopThreadRegistrations.insert({
      registrationKey: 'key-live',
      homeIdentity: codexHome,
      sqliteHome: codexHome,
      nativeThreadId: DESKTOP_THREAD,
      scopeRef: RESERVED,
      agentId: 'stella',
      projectId: 'hrc-ios',
      slotToken: 'primary-nova',
      laneRef: 'main',
      hostSessionId: 'hsid-live',
      projectRoot: praesidium,
      workspaceCwd: praesidium,
      registeredVia: 'test',
      createdAt: NOW,
      updatedAt: NOW,
    })
    db.sessions.insert({
      hostSessionId: 'hsid-live',
      scopeRef: RESERVED,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    db.continuities.upsert({
      scopeRef: RESERVED,
      laneRef: 'main',
      activeHostSessionId: 'hsid-live',
      updatedAt: NOW,
    })
  })

  it('refuses to birth a runtime on a desktop address, with a retryable reason', () => {
    let error: { code?: string; detail?: Record<string, unknown>; message?: string } | undefined
    try {
      assertDesktopScopeNotColdBorn(db, RESERVED)
    } catch (caught) {
      error = caught as {
        code?: string
        detail?: Record<string, unknown>
        message?: string
      }
    }
    expect(error).toBeDefined()
    // Retryable: the mail is PENDING under the registered address until desktop
    // is available. Desktop being closed is not a delivery failure.
    expect(error?.detail?.['retryable']).toBe(true)
    expect(error?.detail?.['reservation']).toBe('codex-desktop')
  })

  it('keeps the reservation after the observer runtime terminates', () => {
    db.runtimes.insert({
      runtimeId: 'rt-observer',
      hostSessionId: 'hsid-live',
      scopeRef: RESERVED,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
      runtimeStateJson: { lifecycleOwner: 'external' },
    })
    db.runtimes.update('rt-observer', {
      status: 'terminated',
      statusChangedAt: NOW,
      updatedAt: NOW,
    })
    // The observer is gone. The address is not.
    expect(isScopeReservedForDesktop(db, RESERVED)).toBe(true)
    expect(db.desktopThreadRegistrations.getByScopeRef(RESERVED)?.nativeThreadId).toBe(
      DESKTOP_THREAD
    )
    expect(() => assertDesktopScopeNotColdBorn(db, RESERVED)).toThrow()
  })
})

// --- the observer invocation shape ----------------------------------------

describe('codex-desktop observer invocation', () => {
  const registration = (): DesktopThreadRegistration => ({
    registrationKey: 'key-observer',
    homeIdentity: '/Users/lherron/.codex',
    sqliteHome: '/Users/lherron/.codex',
    nativeThreadId: DESKTOP_THREAD,
    scopeRef: 'agent:stella:project:hrc-ios:task:primary-nova',
    agentId: 'stella',
    projectId: 'hrc-ios',
    slotToken: 'primary-nova',
    laneRef: 'main',
    hostSessionId: 'hsid-observer',
    projectRoot: '/Users/lherron/praesidium/clients/hrc-ios',
    workspaceCwd: '/Users/lherron/praesidium/clients/hrc-ios',
    registeredVia: 'startup',
    createdAt: NOW,
    updatedAt: NOW,
  })

  const session = (): HrcSessionRecord => ({
    hostSessionId: 'hsid-observer',
    scopeRef: 'agent:stella:project:hrc-ios:task:primary-nova',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })

  const driver = {
    kind: 'codex-desktop' as const,
    bundleExecutable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    codexHome: '/Users/lherron/.codex',
    sqliteHome: '/Users/lherron/.codex',
    threadId: DESKTOP_THREAD,
    rolloutPath: `/Users/lherron/.codex/sessions/2026/09/08/rollout-${DESKTOP_THREAD}.jsonl`,
  }

  const build = () =>
    buildDesktopObserverPlan({
      registration: registration(),
      session: session(),
      runtimeId: 'rt-observer',
      runId: 'run-observer',
      driver,
      now: NOW,
    })

  it('validates against the PUBLIC broker start-request schema', () => {
    // The point of asserting against the real validator rather than a belief:
    // it is what rejects `harnessTransport: in-process` and an `sdk` block on a
    // non-SDK driver, both of which the template this was copied from carries.
    expect(() => validateInvocationStartRequest(build().startRequest)).not.toThrow()
  })

  it('carries the private driver config through the generic extension point', () => {
    const spec = build().startRequest.spec as unknown as Record<string, unknown>
    expect(spec['driver']).toEqual(driver)
    expect((spec['harness'] as Record<string, unknown>)['driver']).toBe('codex-desktop')
    expect(spec['sdk']).toBeUndefined()
    expect(
      ((spec['process'] as Record<string, unknown>)['harnessTransport'] as Record<string, unknown>)[
        'kind'
      ]
    ).toBe('pipes')
  })

  it('never carries an initial input into a conversation HRC does not own', () => {
    expect(build().startRequest.initialInput).toBeUndefined()
  })

  it('declares queue-only, non-interruptible, keep-alive capabilities', () => {
    const capabilities = build().profile.expectedCapabilities
    expect(capabilities.input.queue).toBe('required')
    expect(capabilities.input.steer).toBe('forbidden')
    expect(capabilities.turns.interrupt).toBe('forbidden')
    // keep-alive is what stops HRC recycling an observer under a live
    // conversation; it must be the ONLY retention mode offered.
    expect(capabilities.lifecycle.runtimeRetention).toEqual(['keep-alive'])
    expect(capabilities.lifecycle.harnessRecovery).toEqual(['none'])
  })

  it('marks the observer runtime externally owned', () => {
    db.sessions.insert(session())
    db.runtimes.insert({
      runtimeId: 'rt-observer',
      hostSessionId: 'hsid-observer',
      scopeRef: 'agent:stella:project:hrc-ios:task:primary-nova',
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const before = db.runtimes.getByRuntimeId('rt-observer')!
    expect(isExternalLifecycleOwner(before)).toBe(false)
    const after = markDesktopRuntimeExternallyOwned(harness.instance, before, registration())
    // This one field is the entire authority boundary: it is what the existing
    // sweep / startup-reconcile / dispatch guards read.
    expect(isExternalLifecycleOwner(after)).toBe(true)
  })
})

// --- observer attachment scheduling ---------------------------------------

describe('observer attachment scheduling', () => {
  const register = async (
    threadId: string,
    overrides: Record<string, unknown> = {}
  ): Promise<DesktopRegistrationResponse> => {
    const rolloutPath = await writeRollout(
      threadId,
      desktopMetaLine(threadId, join(praesidium, 'clients', 'hrc-ios'))
    )
    return await registerDesktopThread.call(
      harness.instance,
      {
        nativeThreadId: threadId,
        codexHome,
        rolloutPath,
        bundleExecutable,
        hookSource: 'startup',
        ...overrides,
      },
      { registryProjects }
    )
  }

  it('schedules an attachment carrying the private driver config', async () => {
    const result = await register(DESKTOP_THREAD)
    expect(result.status === 'registered' && result.attachment.scheduled).toBe(true)
    // The scheduled work is not awaited by registration, so let it run.
    await settleAttachments()
    expect(harness.attachments).toHaveLength(1)
    expect(harness.attachments[0]).toMatchObject({
      kind: 'codex-desktop',
      // Reported verbatim — the bundle is compatibility metadata, not identity.
      bundleExecutable,
      // CANONICALIZED — `/var/folders/...` realpaths to `/private/var/folders/...`
      // on macOS, and two spellings of one home would be two identities.
      codexHome: canonicalPath(codexHome),
      sqliteHome: canonicalPath(codexHome),
      threadId: DESKTOP_THREAD,
    })
  })

  it('does not attach a SECOND observer when one is already live', async () => {
    const first = await register(DESKTOP_THREAD)
    await settleAttachments()
    const hostSessionId = first.status === 'registered' ? first.cache.hostSessionId : 'none'
    db.runtimes.insert({
      runtimeId: 'rt-observer-live',
      hostSessionId,
      scopeRef: first.status === 'registered' ? first.cache.scopeRef : 'none',
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
      runtimeStateJson: { lifecycleOwner: 'external' },
    })
    const attachmentsBefore = harness.attachments.length

    const again = await register(DESKTOP_THREAD, {
      hookSource: 'user-prompt-submit',
    })
    await settleAttachments()

    expect(again.status === 'registered' && again.attachment.scheduled).toBe(false)
    expect(
      again.status === 'registered' && !again.attachment.scheduled && again.attachment.reason
    ).toBe('already_attached')
    expect(harness.attachments).toHaveLength(attachmentsBefore)
    expect(again.status === 'registered' && again.observation.state).toBe('attached')
  })

  it('RECOVERY: re-registration after a TERMINATED observer reattaches on the SAME address', async () => {
    // Narrow by design: a terminated row is only ONE way an observer stops, and
    // it is the one HRC itself causes (dispose/evict). The mechanisms production
    // actually hits — a broker crash and a replay-stale detach — leave
    // `status: 'ready'` untouched and are covered in
    // t08294-desktop-observer-recovery.test.ts against the real handlers. Read
    // this one as the terminated-row case, not as recovery coverage.

    const first = await register(DESKTOP_THREAD)
    await settleAttachments()
    const scopeRef = first.status === 'registered' ? first.cache.scopeRef : 'none'
    const hostSessionId = first.status === 'registered' ? first.cache.hostSessionId : 'none'
    db.runtimes.insert({
      runtimeId: 'rt-observer-dead',
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
      runtimeStateJson: { lifecycleOwner: 'external' },
    })
    // The observer exits. This is NOT a statement about the desktop thread.
    db.runtimes.update('rt-observer-dead', {
      status: 'terminated',
      statusChangedAt: NOW,
      updatedAt: NOW,
    })
    const attachmentsBefore = harness.attachments.length

    const again = await register(DESKTOP_THREAD, { hookSource: 'resume' })
    await settleAttachments()

    expect(again.status === 'registered' && again.attachment.scheduled).toBe(true)
    expect(harness.attachments).toHaveLength(attachmentsBefore + 1)
    // Same permanent address, no second name, no new mapping.
    expect(again.status === 'registered' && again.cache.scopeRef).toBe(scopeRef)
    expect(again.status === 'registered' && again.created).toBe(false)
    expect(db.desktopThreadRegistrations.listAll()).toHaveLength(1)
    // And nothing was cold-born onto the address to "recover" it.
    expect(harness.started).toHaveLength(0)
  })

  it('defers attachment, keeping the address, when the rollout is not readable', async () => {
    const result = await registerDesktopThread.call(
      harness.instance,
      {
        nativeThreadId: DESKTOP_THREAD,
        codexHome,
        rolloutPath: await writeRollout(
          DESKTOP_THREAD,
          desktopMetaLine(DESKTOP_THREAD, join(praesidium, 'clients', 'hrc-ios'))
        ),
        bundleExecutable,
        hookSource: 'startup',
      },
      { registryProjects }
    )
    expect(result.status).toBe('registered')
    await settleAttachments()
    harness.attachments.length = 0

    // The rollout disappears (replaced, rotated, or archived under the seat).
    const registration = db.desktopThreadRegistrations.listAll()[0]!
    db.desktopThreadRegistrations.updateObservation(registration.registrationKey, {
      rolloutPath: join(codexHome, 'sessions', 'gone.jsonl'),
      updatedAt: NOW,
    })
    for (const runtime of db.runtimes.listByHostSessionId(registration.hostSessionId)) {
      db.runtimes.update(runtime.runtimeId, {
        status: 'terminated',
        updatedAt: NOW,
      })
    }

    const disposition = scheduleDesktopObserverAttachment(
      harness.instance,
      db.desktopThreadRegistrations.getByRegistrationKey(registration.registrationKey)!
    )
    expect(disposition.scheduled).toBe(false)
    expect(!disposition.scheduled && disposition.reason).toBe('rollout_unavailable')
    expect(harness.attachments).toHaveLength(0)
    // Silence never fabricates a terminal fact: the address is still reserved.
    expect(isScopeReservedForDesktop(db, registration.scopeRef)).toBe(true)
  })
})
