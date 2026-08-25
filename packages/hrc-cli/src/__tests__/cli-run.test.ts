/**
 * RED/GREEN tests for hrc-cli (T-00957)
 *
 * These tests validate the CLI arg parsing, command dispatch, and output
 * formatting for the `hrc` operator CLI. The CLI is a thin wrapper over
 * hrc-sdk; these tests verify the wrapper layer specifically.
 *
 * Pass conditions for Curly (T-00957):
 *   1. `hrc` with no args prints help text to stderr and exits 2
 *   2. `hrc unknowncmd` prints error to stderr and exits 2
 *   3. `hrc session rotate` validates args and dispatches through
 *      hrc-sdk; `hrc turn` is a passthrough alias for `hrcchat turn`
 *      to stderr and exit 2
 *   4. `hrc server` starts the daemon (tested via createHrcServer delegation)
 *   5. `hrc session resolve --scope <scopeRef>` outputs JSON to stdout
 *   6. `hrc session list` outputs JSON array to stdout
 *   7. `hrc session get <hostSessionId>` outputs JSON to stdout
 *   8. monitor commands expose snapshots and event streams
 *   9. All structured output is valid JSON on stdout; all errors on stderr
 *  10. Exit code 0 on success, 1 on error
 *
 * Reference: T-00946 (parent), T-00957 (CLI implementation task)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { HrcClient } from 'hrc-sdk'
// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'
import { buildManagedRunIntent, resolveManagedScopeContext } from '../cli/scope'

import {
  agentsRoot,
  projectsRoot,
  restoreEnvValue,
  seedRunRoots,
  serverOpts,
  setServer,
  setupCliFixture,
  socketPath,
  teardownCliFixture,
} from './fixtures/cli.fixture'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('hrc run', () => {
  beforeEach(async () => {
    setServer(await createHrcServer(serverOpts()))
    await seedRunRoots('rex', 'agent-spaces')
  })

  it('admits canonical CLI-built prompt and no-prompt intents on the attached broker-tmux path', async () => {
    const originalAgentsRoot = process.env['ASP_AGENTS_ROOT']
    process.env['ASP_AGENTS_ROOT'] = agentsRoot
    const client = new HrcClient(socketPath)

    try {
      for (const testCase of [
        { taskId: 'T-00123', prompt: undefined },
        { taskId: 'T-00124', prompt: 'Fix the bug' },
      ]) {
        const scope = resolveManagedScopeContext(`rex@agent-spaces:${testCase.taskId}`, {
          projectRootOverride: join(projectsRoot, 'agent-spaces'),
          registerPolicy: 'never',
        })
        const intent = buildManagedRunIntent(scope, { prompt: testCase.prompt })
        const resolved = await client.resolveSession({
          sessionRef: scope.sessionRef,
          runtimeIntent: intent,
          create: true,
          summonIntent: 'explicit_local',
        })

        expect(resolved.found).toBe(true)
        expect(scope.sessionRef).toBe(
          `agent:rex:project:agent-spaces:task:${testCase.taskId}/lane:main`
        )
        expect(intent.harness.interactive).toBe(true)
        expect(intent.execution?.preferredMode).toBe('interactive')
        expect(intent.initialPrompt).toBe(testCase.prompt)

        const prepared = await client.prepareAttachedRun({
          hostSessionId: resolved.hostSessionId,
          intent,
          restartStyle: 'reuse_pty',
          ...(testCase.prompt ? { prompt: testCase.prompt } : {}),
        })

        expect(prepared.status).toBe('prepared')
        expect(prepared.attach.argv[0]?.startsWith('/')).toBe(true)
        expect(prepared.attach.argv[0]?.endsWith('/tmux')).toBe(true)
        expect(prepared.attach.bindingFence.hostSessionId).toBe(resolved.hostSessionId)
        expect(prepared.attach.bindingFence.runtimeId).toMatch(/^rt-/)
      }
    } finally {
      restoreEnvValue('ASP_AGENTS_ROOT', originalAgentsRoot)
    }
  })
})

// ===========================================================================
// 6. hrc session resolve — JSON output
// ===========================================================================
