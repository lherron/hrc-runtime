/**
 * T-08597 — fake daemon serving FROZEN pre-migration local semantics.
 *
 * Each route runs the ad04040d implementation (see ./old-local-engine) over
 * the test socket: `POST /v1/placements/resolve` composes the old SDK policy +
 * spaces-config facts; `POST /v1/declarations/resolve` runs the old intent
 * assembler. Command-level CLI tests keep asserting their exact historical
 * expectations hermetically (point the CLI at it via `HRC_RUNTIME_DIR`).
 *
 * Correctness of the NEW daemon-backed path is proved by the T-08597 route
 * parity table, not here. Do not edit for behavior.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseScopeRef } from 'agent-scope'
import {
  buildRuntimeBundleRef,
  getAgentsRoot,
  getAspHome,
  parseAgentProfile,
  resolveHarnessCatalogEntry,
} from 'spaces-config'

import { type FakeDaemon, startFakeDaemon } from './fake-daemon.js'
import { resolveHrcAgentPlacementPaths } from './old-local-engine/project-placement.js'
import {
  buildHrcRuntimeIntent,
  resolveAgentHarness,
} from './old-local-engine/runtime-intent-assembly.js'

function readRoleOperator(agentRoot: string): { role?: string; operator: boolean } {
  try {
    const profile = parseAgentProfile(
      readFileSync(join(agentRoot, 'agent-profile.toml'), 'utf8'),
      join(agentRoot, 'agent-profile.toml')
    ) as unknown as { identity?: { role?: string }; operator?: boolean }
    return {
      ...(typeof profile.identity?.role === 'string' ? { role: profile.identity.role } : {}),
      operator: profile.operator === true,
    }
  } catch {
    return { operator: false }
  }
}

export function startOldEngineDaemon(): FakeDaemon {
  return startFakeDaemon({
    placement: (request) => {
      const scopeRef = request['scopeRef']
      let agentId = request['agentId']
      let projectId = request['projectId']
      let taskId = request['taskId']
      if (typeof scopeRef === 'string') {
        const parsed = parseScopeRef(scopeRef)
        agentId = parsed.agentId
        projectId = parsed.projectId
        taskId = parsed.taskId
      }
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new Error('agentId or scopeRef is required')
      }
      const projectOrigin =
        request['projectOrigin'] === 'inferred' || projectId === undefined ? 'inferred' : 'explicit'
      const paths = resolveHrcAgentPlacementPaths({
        agentId,
        ...(typeof projectId === 'string' ? { projectId } : {}),
        projectOrigin,
        ...(typeof taskId === 'string' ? { taskId } : {}),
        ...(typeof request['cwd'] === 'string' ? { cwd: request['cwd'] } : {}),
        ...(typeof request['projectRoot'] === 'string'
          ? { projectRoot: request['projectRoot'] }
          : {}),
        ...(typeof request['agentRoot'] === 'string' ? { agentRoot: request['agentRoot'] } : {}),
      })
      const harness =
        paths.agentRoot === undefined
          ? undefined
          : resolveAgentHarness({
              agentRoot: paths.agentRoot,
              agentId,
              ...(paths.projectRoot !== undefined ? { projectRoot: paths.projectRoot } : {}),
            })
      const entry =
        harness?.harness === undefined ? undefined : resolveHarnessCatalogEntry(harness.harness)
      const bundle =
        paths.agentRoot === undefined
          ? undefined
          : buildRuntimeBundleRef({
              agentName: agentId,
              agentRoot: paths.agentRoot,
              ...(paths.projectRoot !== undefined ? { projectRoot: paths.projectRoot } : {}),
            })
      const identity =
        paths.agentRoot === undefined ? { operator: false } : readRoleOperator(paths.agentRoot)
      return {
        agentId,
        ...(typeof projectId === 'string' ? { projectId } : {}),
        ...(typeof taskId === 'string' ? { taskId } : {}),
        ...(paths.agentRoot !== undefined ? { agentRoot: paths.agentRoot } : {}),
        ...(paths.projectRoot !== undefined ? { projectRoot: paths.projectRoot } : {}),
        ...(paths.cwd !== undefined ? { cwd: paths.cwd } : {}),
        ...(bundle !== undefined ? { bundle } : {}),
        ...(harness !== undefined && entry !== undefined
          ? {
              harness: {
                provider: entry.provider,
                frontend: entry.frontend,
                effectiveHarness: entry.id,
                transport: entry.transport,
                interactive: entry.transport !== 'sdk',
              },
            }
          : {}),
        ...(harness !== undefined
          ? {
              provision: {
                scalars: harness.provision,
                ...(typeof (harness.provision as Record<string, unknown>)['harness'] === 'string'
                  ? {
                      declaredHarness: (harness.provision as Record<string, unknown>)[
                        'harness'
                      ] as string,
                    }
                  : {}),
              },
            }
          : { provision: { scalars: {} } }),
        policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
        identity,
        agentSources: { aspHome: getAspHome(), agentsRoot: getAgentsRoot() },
        searchedAgentRoots: paths.searchedAgentRoots ?? [],
        source: {
          agentProfile: 'valid',
          projectTargets: 'valid',
          selectedTarget: 'absent',
          priming: 'valid',
        },
        resolution: paths.resolution,
        warnings: paths.warnings ?? [],
        release: { releaseId: 'fake-old-engine', sourceCommit: 'ad04040d' },
      }
    },
    declaration: (request) => {
      const intent = buildHrcRuntimeIntent({
        agentId: request['agentId'] as string,
        agentRoot: request['agentRoot'] as string,
        ...(typeof request['projectRoot'] === 'string'
          ? { projectRoot: request['projectRoot'] as string }
          : {}),
        ...(typeof request['cwd'] === 'string' ? { cwd: request['cwd'] as string } : {}),
        ...(typeof request['runMode'] === 'string'
          ? { runMode: request['runMode'] as 'task' }
          : {}),
        ...(typeof request['interactive'] === 'boolean'
          ? { interactive: request['interactive'] }
          : {}),
        ...(typeof request['preferredMode'] === 'string'
          ? { preferredMode: request['preferredMode'] as 'nonInteractive' }
          : {}),
        ...(typeof request['allowInteractiveSurfaceReuse'] === 'boolean'
          ? { allowInteractiveSurfaceReuse: request['allowInteractiveSurfaceReuse'] }
          : {}),
        ...(typeof request['initialPrompt'] === 'string'
          ? { initialPrompt: request['initialPrompt'] }
          : {}),
        ...(request['provision'] !== undefined
          ? { provision: request['provision'] as Record<string, string | number | boolean> }
          : {}),
      })
      return {
        intent,
        declaration: {
          release: { releaseId: 'fake-old-engine', sourceCommit: 'ad04040d' },
          agentSources: {},
          source: {
            agentProfile: 'valid',
            projectTargets: 'valid',
            selectedTarget: 'absent',
            priming: 'valid',
          },
          warnings: [],
        },
      }
    },
  })
}

export function oldEngineDaemonEnv(daemon: FakeDaemon): Record<string, string> {
  return { HRC_RUNTIME_DIR: daemon.runtimeDir }
}

/**
 * Install a suite-old-engine fake for the importing test file: starts the
 * daemon, points CLI socket discovery at it for the file's duration, and
 * returns a stop handle for `afterAll`. Each file gets its own socket.
 */
export function installOldEngineDaemon(): {
  stop: () => void
  runtimeDir: string
  setProxy: (socketPath: string | undefined) => void
} {
  const daemon = startOldEngineDaemon()
  // Deliberately no save/restore: bun imports every test file before running
  // any of them, so per-file teardown would delete the var out from under
  // later files (all fakes serve identical old-engine semantics; the last
  // installed socket serves the whole run). Stopping only closes this socket.
  process.env['HRC_RUNTIME_DIR'] = daemon.runtimeDir
  let stopped = false
  return {
    runtimeDir: daemon.runtimeDir,
    setProxy: (socketPath: string | undefined) => daemon.setProxy(socketPath),
    stop: () => {
      if (stopped) return
      stopped = true
      daemon.stop()
    },
  }
}
