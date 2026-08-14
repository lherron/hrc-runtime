/**
 * T-07235 — diagnostic bundle: redaction by construction, generation fencing,
 * and the hard budget.
 *
 * The secret boundary is the point of this file. Redaction happens as each
 * value is COPIED IN, not by masking a rendered string afterwards, and the
 * `displayCommand` renderer (which shell-quotes argv and env verbatim) is
 * banned from this path outright.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { assembleFirstTurnBundle, redactArgv, redactPromptValue } from '../first-turn-bundle'

const HOST_SESSION_ID = 'hsid-bundle'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-07235'
const LANE_REF = 'default'
const RUNTIME_ID = 'rt-bundle'
const RUN_ID = 'run-bundle'
const INVOCATION_ID = 'inv-bundle'
const SECRET_PROMPT = 'do the secret thing with the secret token'
const SECRET_PRIMING = 'ASP priming: never render me verbatim'

const NOW = '2026-08-14T12:00:00.000Z'

type Fixture = {
  db: ReturnType<typeof openHrcDatabase>
  dir: string
  runtimeRoot: string
  cleanup: () => Promise<void>
}

async function makeFixture(specProjection?: unknown): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-ft-bundle-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  const runtimeRoot = join(dir, 'run')

  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeInvocationId: INVOCATION_ID,
    createdAt: NOW,
    updatedAt: NOW,
  })
  if (specProjection !== undefined) {
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: 'op-bundle',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'claude-code-tmux',
      invocationState: 'starting',
      capabilitiesJson: '{}',
      specHash: 'sha256:spec',
      startRequestHash: 'sha256:req',
      selectedProfileHash: 'sha256:prof',
      specProjectionJson: JSON.stringify(specProjection),
      createdAt: NOW,
      updatedAt: NOW,
    })
  }

  return {
    db,
    dir,
    runtimeRoot,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function watchRecord(generation = 1) {
  return {
    runtimeId: RUNTIME_ID,
    generation,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    primingDispatchedAt: NOW,
    firstTurnDeadlineAt: '2026-08-14T12:02:00.000Z',
    firstTurnMissingTrippedAt: '2026-08-14T12:02:01.000Z',
    tripEventSeq: 4242,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const SPEC_WITH_PROMPTS = {
  harness: { frontend: 'claude-code', provider: 'anthropic', driver: 'claude-code-tmux' },
  process: {
    command: '/usr/local/bin/claude',
    args: ['--model', 'opus', '-p', SECRET_PROMPT, '--dangerously-skip-permissions'],
    cwd: '/Users/lherron/praesidium/hrc-runtime',
    lockedEnv: {
      ASP_PRIMING_PROMPT: SECRET_PRIMING,
      ANTHROPIC_API_KEY: 'sk-should-never-be-captured',
      HOME: '/Users/lherron',
    },
  },
  continuation: { provider: 'anthropic', key: 'sess-abc', kind: 'session' },
  launch: { initialPrompt: SECRET_PROMPT },
}

let fixture: Fixture

afterEach(async () => {
  await fixture?.cleanup()
})

describe('redactArgv', () => {
  it('hashes the value that follows a prompt-bearing flag', () => {
    expect(redactArgv(['-p', SECRET_PROMPT], [])).toEqual(['-p', redactPromptValue(SECRET_PROMPT)])
  })

  it('hashes every positional past `--`, which is prompt material by contract', () => {
    const out = redactArgv(['claude', '--', SECRET_PROMPT], [])
    expect(out[2]).toBe(redactPromptValue(SECRET_PROMPT))
    expect(out[2]).not.toContain('secret')
  })

  it('hashes an inline --prompt=<value>', () => {
    const out = redactArgv([`--prompt=${SECRET_PROMPT}`], [])
    expect(out[0]).toBe(`--prompt=${redactPromptValue(SECRET_PROMPT)}`)
  })

  it('hashes any element that equals a known prompt, whatever its position', () => {
    const out = redactArgv(['exec', SECRET_PROMPT], [SECRET_PROMPT])
    expect(out[1]).toBe(redactPromptValue(SECRET_PROMPT))
  })

  it('leaves ordinary flags untouched so the launch shape stays readable', () => {
    expect(redactArgv(['--model', 'opus', '--verbose'], [])).toEqual([
      '--model',
      'opus',
      '--verbose',
    ])
  })
})

describe('bundle assembly', () => {
  it('captures the launch shape with every prompt-bearing value hashed', async () => {
    fixture = await makeFixture(SPEC_WITH_PROMPTS)
    const { bundle } = await assembleFirstTurnBundle(
      {
        db: fixture.db,
        options: { runtimeRoot: fixture.runtimeRoot },
        budgetMs: 2_000,
        now: () => NOW,
      },
      watchRecord()
    )

    const shape = bundle.launchShape
    expect(shape).toBeDefined()
    expect(shape?.frontend).toBe('claude-code')
    expect(shape?.cwd).toBe('/Users/lherron/praesidium/hrc-runtime')
    expect(shape?.continuation).toBe('expected')

    const rendered = JSON.stringify(bundle)
    expect(rendered).not.toContain(SECRET_PROMPT)
    expect(rendered).not.toContain(SECRET_PRIMING)
    expect(rendered).toContain(`sha256:${createHash('sha256').update(SECRET_PROMPT).digest('hex')}`)
    expect(shape?.promptEnv['ASP_PRIMING_PROMPT']).toBe(redactPromptValue(SECRET_PRIMING))
  })

  it('never captures process env beyond the known prompt-bearing keys', async () => {
    fixture = await makeFixture(SPEC_WITH_PROMPTS)
    const { bundle } = await assembleFirstTurnBundle(
      {
        db: fixture.db,
        options: { runtimeRoot: fixture.runtimeRoot },
        budgetMs: 2_000,
        now: () => NOW,
      },
      watchRecord()
    )
    expect(Object.keys(bundle.launchShape?.promptEnv ?? {})).toEqual(['ASP_PRIMING_PROMPT'])
    const rendered = JSON.stringify(bundle)
    expect(rendered).not.toContain('sk-should-never-be-captured')
    expect(rendered).not.toContain('/Users/lherron"')
  })

  it('records continuation expectation as none when the spec carries no key', async () => {
    fixture = await makeFixture({ ...SPEC_WITH_PROMPTS, continuation: undefined })
    const { bundle } = await assembleFirstTurnBundle(
      {
        db: fixture.db,
        options: { runtimeRoot: fixture.runtimeRoot },
        budgetMs: 2_000,
        now: () => NOW,
      },
      watchRecord()
    )
    expect(bundle.launchShape?.continuation).toBe('none')
    expect(bundle.launchShape?.continuationKey).toBeUndefined()
  })

  it('writes the manifest (and no pane file when nothing was captured)', async () => {
    fixture = await makeFixture(SPEC_WITH_PROMPTS)
    const { bundleDir } = await assembleFirstTurnBundle(
      {
        db: fixture.db,
        options: { runtimeRoot: fixture.runtimeRoot },
        budgetMs: 2_000,
        now: () => NOW,
      },
      watchRecord()
    )
    expect(bundleDir).toBe(
      join(fixture.runtimeRoot, 'artifacts', RUNTIME_ID, 'first-turn-missing', '4242')
    )
    const entries = await readdir(bundleDir)
    expect(entries).toContain('manifest.json')
    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8')) as {
      correlation: { runtimeId: string }
    }
    expect(manifest.correlation.runtimeId).toBe(RUNTIME_ID)
  })

  it('reports a named failure instead of guessing when the spec projection is absent', async () => {
    fixture = await makeFixture()
    const { bundle } = await assembleFirstTurnBundle(
      {
        db: fixture.db,
        options: { runtimeRoot: fixture.runtimeRoot },
        budgetMs: 2_000,
        now: () => NOW,
      },
      watchRecord()
    )
    expect(bundle.launchShape).toBeUndefined()
    expect(bundle.failures['launchShape']).toBe('spec_projection_unavailable')
  })

  it('fences live probes on generation: a rotated runtime records generation_rotated', async () => {
    fixture = await makeFixture(SPEC_WITH_PROMPTS)
    // Give the runtime a leased tmux surface so a pane capture would be attempted.
    fixture.db.runtimes.update(RUNTIME_ID, {
      generation: 2,
      tmuxJson: {
        socketPath: join(fixture.dir, 'btmux.sock'),
        sessionName: 'hrc-lease',
        windowName: 'tui',
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
      },
      updatedAt: NOW,
    })

    const { bundle } = await assembleFirstTurnBundle(
      {
        db: fixture.db,
        options: { runtimeRoot: fixture.runtimeRoot },
        budgetMs: 2_000,
        now: () => NOW,
      },
      // The trip belongs to generation 1; the runtime has since rotated to 2.
      watchRecord(1)
    )
    expect(bundle.failures['paneCapture']).toBe('generation_rotated')
    expect(bundle.paneCapture).toBeUndefined()
  })

  it('records no_leased_tmux_pane rather than silently omitting the capture', async () => {
    fixture = await makeFixture(SPEC_WITH_PROMPTS)
    const { bundle } = await assembleFirstTurnBundle(
      {
        db: fixture.db,
        options: { runtimeRoot: fixture.runtimeRoot },
        budgetMs: 2_000,
        now: () => NOW,
      },
      watchRecord()
    )
    expect(bundle.failures['paneCapture']).toBe('no_leased_tmux_pane')
  })
})

describe('displayCommand ban', () => {
  it('the bundle path never references the verbatim command renderer', async () => {
    const source = await readFile(
      new URL('../first-turn-bundle.ts', import.meta.url).pathname,
      'utf8'
    )
    // `displayCommand` shell-quotes argv and env verbatim; only the sentence
    // that documents the ban may mention it.
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    expect(codeLines.join('\n')).not.toContain('displayCommand')
    expect(codeLines.join('\n')).not.toContain('formatDisplayCommand')
  })
})
