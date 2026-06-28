import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'
import { HrcClient } from 'hrc-sdk'

import {
  HRC_COMMAND_RUN_TARGETS_FILE_ENV,
  createHrcServer,
  loadCommandRunTargetsFromEnv,
} from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

async function withCommandRunTargetsEnv<T>(
  value: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const previous = process.env[HRC_COMMAND_RUN_TARGETS_FILE_ENV]
  if (value === undefined) {
    delete process.env[HRC_COMMAND_RUN_TARGETS_FILE_ENV]
  } else {
    process.env[HRC_COMMAND_RUN_TARGETS_FILE_ENV] = value
  }

  try {
    return await fn()
  } finally {
    if (previous === undefined) {
      delete process.env[HRC_COMMAND_RUN_TARGETS_FILE_ENV]
    } else {
      process.env[HRC_COMMAND_RUN_TARGETS_FILE_ENV] = previous
    }
  }
}

function requestFor(configuredTargetId: string, idempotencyKey = randomUUID()) {
  return {
    configuredTargetId,
    sessionRef: 'agent:larry/project:hrc-runtime/task:T-05283/lane:config',
    idempotencyKey,
    binding: {
      WRKF_TASK_ID: 'T-05283',
      WRKF_ACTION_RUN_ID: `action-run-${idempotencyKey}`,
      WRKF_RUN_ID: `wrkf-run-${idempotencyKey}`,
      WRKF_ACTION: 'validate',
      WRKF_ROLE: 'larry',
      ASP_PROJECT: 'hrc-runtime',
      HRC_SESSION_REF: 'agent:larry/project:hrc-runtime/task:T-05283/lane:config',
      HRC_LANE: 'config',
    },
    stdinJson: { ok: true },
  } as const
}

async function startServerFromEnv(
  fixture: HrcServerTestFixture,
  configPath: string | undefined
): Promise<HrcServer> {
  return withCommandRunTargetsEnv(configPath, () =>
    createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, commandRunTargets: undefined })
    )
  )
}

describe('command-run target startup config', () => {
  it('loads HRC_COMMAND_RUN_TARGETS_FILE and resolves a configured target at launch', async () => {
    const fixture = await createHrcTestFixture('hrc-cmd-env-')
    const configPath = join(fixture.tmpDir, 'command-run-targets.json')
    await writeFile(
      configPath,
      JSON.stringify({
        'env-configured-target': {
          launchMode: 'exec',
          argv: [process.execPath, '-e', 'process.exit(0)'],
        },
      })
    )

    const server = await startServerFromEnv(fixture, configPath)
    try {
      const client = new HrcClient(fixture.socketPath)
      const result = await client.launchCommandScopedRun(requestFor('env-configured-target'))

      expect(result.runId).toMatch(/^run-/)
      expect(result.runtimeId).toMatch(/^rt-/)
      expect(result.transport).toBe('tmux')
      expect(result.replayed).toBe(false)
    } finally {
      await server.stop()
      await fixture.cleanup()
    }
  })

  it('uses an empty target map when HRC_COMMAND_RUN_TARGETS_FILE is unset', async () => {
    const fixture = await createHrcTestFixture('hrc-cmd-empty-')
    const server = await startServerFromEnv(fixture, undefined)
    try {
      const client = new HrcClient(fixture.socketPath)

      await expect(
        client.launchCommandScopedRun(requestFor('missing-target'))
      ).rejects.toMatchObject({
        code: 'unknown_runtime',
        message: 'unknown command-run target "missing-target"',
      })
    } finally {
      await server.stop()
      await fixture.cleanup()
    }
  })

  it('keeps unknown configured ids as launch-time not-found errors', async () => {
    const fixture = await createHrcTestFixture('hrc-cmd-unknown-')
    const configPath = join(fixture.tmpDir, 'command-run-targets.json')
    await writeFile(
      configPath,
      JSON.stringify({
        known: {
          launchMode: 'exec',
          argv: [process.execPath, '-e', 'process.exit(0)'],
        },
      })
    )

    const server = await startServerFromEnv(fixture, configPath)
    try {
      const client = new HrcClient(fixture.socketPath)

      await expect(client.launchCommandScopedRun(requestFor('unknown'))).rejects.toMatchObject({
        code: 'unknown_runtime',
        message: 'unknown command-run target "unknown"',
      })
    } finally {
      await server.stop()
      await fixture.cleanup()
    }
  })

  it('fails fast when the configured target file is malformed', async () => {
    const fixture = await createHrcTestFixture('hrc-cmd-bad-')
    const configPath = join(fixture.tmpDir, 'command-run-targets.json')
    await writeFile(configPath, JSON.stringify({ bad: { launchMode: 'exec' } }))

    try {
      await withCommandRunTargetsEnv(configPath, async () => {
        await expect(loadCommandRunTargetsFromEnv()).rejects.toThrow(
          /HRC_COMMAND_RUN_TARGETS_FILE .* target "bad" is invalid: configured command-run target has no argv/
        )
      })
    } finally {
      await fixture.cleanup()
    }
  })
})
