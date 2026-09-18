/**
 * T-08596 (T-08569A closure) test fixture — a frozen aspd worker launch for
 * substrate allocation tests. The toolchain resolver is deleted, so every
 * allocation under test carries the executable + argv an aspd preparation
 * would have frozen; the allocator launches them EXACTLY and asserts the
 * HRC-owned hosting flags match.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describeBrokerSubstratePaths } from '../../broker-interactive-handlers/substrate-allocator'
import { getBrokerObserverSocketPath } from '../../tmux-socket'

export type FrozenLaunchInput = {
  runtimeRoot: string
  driverKind: string
  runtimeId: string
  hostSessionId: string
  generation: number
  /** Include the frozen `--experimental-observer-socket` flag (viewer/observer substrates). */
  withObserverSocket?: boolean | undefined
}

/** A real executable (named `harness-broker`) plus argv satisfying the frozen hosting assertion. */
export async function makeFrozenWorkerLaunch(
  input: FrozenLaunchInput
): Promise<{ executable: string; argv: string[] }> {
  const binDir = join(input.runtimeRoot, 'frozen-bin')
  await mkdir(binDir, { recursive: true })
  const executable = join(binDir, 'harness-broker')
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  const paths = describeBrokerSubstratePaths(
    { runtimeRoot: input.runtimeRoot },
    input.driverKind,
    input.runtimeId
  )
  const observerSocketPath = input.withObserverSocket
    ? getBrokerObserverSocketPath(
        { runtimeRoot: input.runtimeRoot },
        input.driverKind,
        input.runtimeId
      )
    : undefined
  const argv = [
    executable,
    'run',
    '--transport',
    'unix',
    '--socket',
    paths.brokerIpcSocketPath,
    '--event-ledger',
    paths.eventLedgerPath,
    '--runtime-id',
    input.runtimeId,
    '--host-session-id',
    input.hostSessionId,
    '--generation',
    String(input.generation),
    '--attach-token-file',
    paths.attachTokenPath,
    ...(observerSocketPath !== undefined
      ? ['--experimental-observer-socket', observerSocketPath]
      : []),
  ]
  return { executable, argv }
}

/** Release identity shared by the frozen launch and the fake broker hello. */
export const FROZEN_RELEASE_IDENTITY = {
  releaseId: 'asp-frozen-fixture',
  sourceCommit: '0000000000000000000000000000000000000000',
  builtAt: '2026-09-18T00:00:00.000Z',
} as const

/**
 * A frozen aspd execution for controller-start inputs: the worker launch above
 * plus the minimal frozen route/release the dispatch graph requires.
 */
export async function makeFrozenAspdExecution(
  input: FrozenLaunchInput & {
    operationId: string
    route: 'headless-codex-app-server' | 'interactive-codex-tui' | 'interactive-tmux-broker'
  }
): Promise<{
  operationId: string
  route: 'headless-codex-app-server' | 'interactive-codex-tui' | 'interactive-tmux-broker'
  release: {
    releaseId: string
    sourceCommit: string
    builtAt: string
    releaseRoot: string
    worker: { protocol: 'harness-broker/0.2'; executable: string; argvPrefix: string[] }
  }
  executable: string
  argv: string[]
}> {
  const launch = await makeFrozenWorkerLaunch(input)
  return {
    operationId: input.operationId,
    route: input.route,
    release: {
      ...FROZEN_RELEASE_IDENTITY,
      releaseRoot: input.runtimeRoot,
      worker: {
        protocol: 'harness-broker/0.2',
        executable: launch.executable,
        argvPrefix: [],
      },
    },
    executable: launch.executable,
    argv: launch.argv,
  }
}

/**
 * Seed the never-submitted `prepared` operation row the controller start graph
 * requires for a frozen launch: boundary P committed it, the start graph moves
 * exactly that row to `starting`.
 */
export function seedPreparedAspdOperation(
  db: { runtimeOperations: { insert: (record: Record<string, unknown>) => unknown } },
  input: {
    operationId: string
    runtimeId: string
    runId: string
    hostSessionId: string
    generation: number
  }
): void {
  const now = '2026-09-18T00:00:00.000Z'
  db.runtimeOperations.insert({
    operationId: input.operationId,
    runtimeId: input.runtimeId,
    runId: input.runId,
    hostSessionId: input.hostSessionId,
    generation: input.generation,
    operationKind: 'broker_invocation',
    controller: 'harness-broker',
    startupMethod: 'broker.startInvocationFromRequest',
    status: 'prepared',
    routeDecisionJson: JSON.stringify({ controller: 'harness-broker' }),
    createdAt: now,
    updatedAt: now,
  })
}
