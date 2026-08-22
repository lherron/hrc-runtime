/**
 * T-07398 DEFECT CYCLE 2, item 2 — a directive on a dm to an EXISTING scope has
 * to leave the CLI.
 *
 * Cycle 1 put the admissibility check on the daemon's dm door, and it works:
 * `POST /v1/messages/dm` with a pin-conflicting `provision` refuses typed with
 * no message row. But it is gated on `body.runtimeIntent?.provision`, and
 * `resolveDmRuntimeIntent` (commands/dm.ts) returns `undefined` whenever
 * `client.getTarget` resolves — i.e. for every scope that already exists. So on
 * the installed surface the directive never leaves the terminal, the daemon has
 * nothing to refuse, and `hrcchat dm "cody@hrc-runtime:hrcdev+node=svc"` still
 * delivers (seq 226). That is the whole suite-vs-live gap for D3: the fixture
 * bar posted the intent directly and never crossed this seam.
 *
 * A conflict is a property of the REQUEST, not of runtime state (endorsed
 * interpretation), so the block must ride along regardless of target liveness —
 * and the daemon, which owns the pin, decides.
 *
 * The second assertion is the guardrail: T-07151 established that an ordinary
 * existing-scope delivery sends NO placement intent, so a drifted checkout can
 * still be corrected by dm. Only a handle that actually carries a `+` block may
 * change that; "always send the intent now" would regress that ruling.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMessageRecord, SemanticDmRequest, SemanticDmResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { cmdDm } from '../commands/dm.js'

const ENV_NAMES = [
  'ASP_AGENTS_ROOT',
  'ASP_DEFAULT_TASK',
  'ASP_PROJECT',
  'ASP_PROJECT_ROOT_OVERRIDE',
  'HRC_SESSION_REF',
] as const

describe('T-07398 cycle 2 item 2 — dm carries directives to already-existing scopes', () => {
  let tmp: string
  let projectRoot: string
  let savedEnv: Map<(typeof ENV_NAMES)[number], string | undefined>

  beforeEach(async () => {
    savedEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))
    for (const name of ENV_NAMES) Reflect.deleteProperty(process.env, name)
    tmp = await mkdtemp(join(tmpdir(), 'hrcchat-t07398-c2-'))
    projectRoot = join(tmp, 'project')
    const agentRoot = join(projectRoot, 'agents', 'cody')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
    await writeFile(join(agentRoot, 'agent-profile.toml'), 'version = 3\n')
    process.env['ASP_AGENTS_ROOT'] = join(tmp, 'canonical-agents')
    process.env['ASP_PROJECT_ROOT_OVERRIDE'] = projectRoot
  })

  afterEach(async () => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
    await rm(tmp, { recursive: true, force: true })
  })

  /** Drives cmdDm against a target that ALREADY EXISTS (getTarget resolves). */
  async function deliverToExistingTarget(handle: string): Promise<SemanticDmRequest[]> {
    const requests: SemanticDmRequest[] = []
    const client = {
      async getTarget() {
        return {} as never
      },
      async semanticDm(request: SemanticDmRequest): Promise<SemanticDmResponse> {
        requests.push(request)
        return { request: messageRecord(request) }
      },
    } as HrcClient

    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      await cmdDm(client, { as: 'human', json: true }, [handle, 'directive at a live scope'])
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }
    return requests
  }

  it('sends the directive block even when the target already exists, and only then', async () => {
    // T-07151 guardrail, asserted FIRST so it also proves the fixture resolves:
    // a bare handle to an existing scope still sends no placement intent, so dm
    // remains usable against a drifted checkout.
    const bare = await deliverToExistingTarget('cody@project:hrcdev')
    expect(bare).toHaveLength(1)
    expect(bare[0]?.runtimeIntent).toBeUndefined()

    // The live repro shape: a `+node=` on a scope that is already up. Same door,
    // same existing target — the only difference is the block on the handle.
    const directed = await deliverToExistingTarget('cody@project:hrcdev+node=svc')
    expect(directed).toHaveLength(1)
    expect(directed[0]?.runtimeIntent).toEqual({ provision: { node: 'svc' } })
  })
})

function messageRecord(request: SemanticDmRequest): HrcMessageRecord {
  return {
    messageSeq: 1,
    messageId: 'msg-t07398-c2',
    createdAt: '2026-08-22T00:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: request.from,
    to: request.to,
    rootMessageId: 'msg-t07398-c2',
    body: request.body,
    bodyFormat: 'text/plain',
    execution: { state: 'accepted' },
  }
}
