import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// T-04767: end-user proof that `hrcchat dm <scopeB> --reply-to <scopeA-message>`
// fails before sending and persists nothing. The guard runs before any session
// lookup/dispatch, so this stays deterministic without seeding a runtime. The
// same-scope-pass and --cross-scope-reply-override paths are unit-tested in
// reply-scope-guard.test.ts (driving them through the CLI would trigger real
// session dispatch).

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const HRCCHAT_MAIN = join(REPO_ROOT, 'packages', 'hrcchat-cli', 'src', 'main.ts')

const REFACWRK = 'agent:clod:project:agent-loop:task:refacwrk'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('reply-scope-guard-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

/** Seed a parent request message that lives in the refacwrk scope. */
function seedParentMessage(): string {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const record = db.messages.insert({
      messageId: 'msg-parent-refacwrk',
      kind: 'dm',
      phase: 'request',
      from: { kind: 'session', sessionRef: `${REFACWRK}/lane:main` },
      to: { kind: 'entity', entity: 'human' },
      body: 'original request from refacwrk',
    })
    return record.messageId
  } finally {
    db.close()
  }
}

function countMessages(): number {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.messages.query({}).length
  } finally {
    db.close()
  }
}

async function runDm(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ['bun', HRCCHAT_MAIN, 'dm', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ASP_PROJECT: 'agent-loop',
      HRC_RUNTIME_DIR: fixture.runtimeRoot,
      HRC_STATE_DIR: fixture.stateRoot,
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe('hrcchat dm reply-scope guard (T-04767)', () => {
  it('fails a cross-scope reply before sending and persists no message', async () => {
    const parentId = seedParentMessage()
    const before = countMessages()

    const result = await runDm(['clod@agent-loop:primary', '--reply-to', parentId, 'done'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('cross-scope reply blocked')
    expect(result.stderr).toContain(REFACWRK)
    expect(result.stderr).toContain('agent:clod:project:agent-loop:task:primary')
    // No new message row — the guard threw before insert.
    expect(countMessages()).toBe(before)
  })
})
