import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHrcServer } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  cliEnv,
  dbPath,
  runCli,
  serverOpts,
  setServer,
  setupCliFixture,
  teardownCliFixture,
  tmpDir,
} from './fixtures/cli.fixture'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('T-07609 admin runtime manifest prune parse path', () => {
  it('registers and forwards the file, include-ledgers, dry-run, and yes flags', async () => {
    setServer(await createHrcServer(serverOpts()))
    const db = openHrcDatabase(dbPath)
    const now = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    try {
      db.sessions.insert({
        hostSessionId: 'hsid-cli-manifest',
        scopeRef: 'agent:mneme:project:signal-pipeline:task:signal-score',
        laneRef: 'default',
        generation: 1,
        status: 'inactive',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-cli-manifest',
        hostSessionId: 'hsid-cli-manifest',
        scopeRef: 'agent:mneme:project:signal-pipeline:task:signal-score',
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'terminated',
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
    } finally {
      db.close()
    }

    const manifestPath = join(tmpDir, 'runtime-ids.txt')
    await writeFile(manifestPath, 'rt-cli-manifest\n')
    const result = await runCli(
      [
        'admin',
        'runtime',
        'prune',
        '--runtime-ids-file',
        manifestPath,
        '--include-ledgers',
        '--dry-run',
        '--yes',
      ],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('runtime prune (dry-run)')
    expect(result.stdout).toContain(`manifest ${manifestPath}`)
    expect(result.stdout).toMatch(/runtimes\s+1/u)

    const readback = openHrcDatabase(dbPath)
    try {
      expect(readback.runtimes.getByRuntimeId('rt-cli-manifest')).not.toBeNull()
    } finally {
      readback.close()
    }
  })

  it('requires every destructive manifest flag at the real Commander boundary', async () => {
    const result = await runCli([
      'admin',
      'runtime',
      'prune',
      '--runtime-ids-file',
      join(tmpDir, 'unused.txt'),
      '--yes',
    ])

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("required option '--include-ledgers'")
  })
})
