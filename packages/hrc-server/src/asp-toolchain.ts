import { constants, accessSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  HrcAspToolchainBinaryKind,
  HrcAspToolchainHelloObservation,
  HrcAspToolchainStatus,
  PraesidiumBuild,
} from 'hrc-core'

import { resolveHoistedBinary } from './hoisted-binary.js'

export type AspToolchainBinarySource = 'env-override' | 'toolchain-root' | 'bundled'

export type AspToolchainBinarySelection = {
  kind: HrcAspToolchainBinaryKind
  name: string
  envVar: string
  source: AspToolchainBinarySource
  path: string
  configuredRoot?: string | undefined
}

const WORKSPACE_ROOT = resolve(import.meta.dir, '..', '..', '..')
export const HRC_ASP_TOOLCHAIN_ROOT_ENV = 'HRC_ASP_TOOLCHAIN_ROOT'

const BINARY_CONFIG: Record<HrcAspToolchainBinaryKind, { name: string; envVar: string }> = {
  'aspc-facade': { name: 'aspc-facade', envVar: 'HRC_ASPC_FACADE_CMD' },
  'harness-broker': { name: 'harness-broker', envVar: 'HRC_HARNESS_BROKER_CMD' },
  'harness-broker-pi': {
    name: 'harness-broker-pi',
    envVar: 'HRC_HARNESS_BROKER_PI_CMD',
  },
  'agent-harness': { name: 'agent-harness', envVar: 'HRC_AGENT_HARNESS_CMD' },
}

export const ASP_TOOLCHAIN_BINARY_KINDS = Object.freeze(
  Object.keys(BINARY_CONFIG) as HrcAspToolchainBinaryKind[]
)

const helloObservations = new Map<
  HrcAspToolchainBinaryKind,
  { path: string; observation: HrcAspToolchainHelloObservation }
>()

function configuredValue(
  env: Record<string, string | undefined>,
  name: string
): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

function unavailableRootBinary(
  kind: HrcAspToolchainBinaryKind,
  root: string,
  path: string,
  reason: string
): HrcRuntimeUnavailableError {
  const config = BINARY_CONFIG[kind]
  const remedy = 'build agent-spaces / check the root'
  return new HrcRuntimeUnavailableError(
    `ASP toolchain root cannot provide executable ${config.name}: ${path}; ${remedy}`,
    {
      kind,
      binary: config.name,
      root,
      path,
      reason,
      remedy,
      env: HRC_ASP_TOOLCHAIN_ROOT_ENV,
    }
  )
}

/**
 * The one ASP child-binary selector. Callers invoke this immediately before
 * each spawn/allocation; no selection is cached at module or controller load.
 */
export function resolveAspToolchainBinary(
  kind: HrcAspToolchainBinaryKind,
  env: Record<string, string | undefined> = process.env
): AspToolchainBinarySelection {
  const config = BINARY_CONFIG[kind]
  const override = configuredValue(env, config.envVar)
  if (override !== undefined) {
    return { kind, ...config, source: 'env-override', path: override }
  }

  const root = configuredValue(env, HRC_ASP_TOOLCHAIN_ROOT_ENV)
  if (root !== undefined) {
    if (!isAbsolute(root)) {
      throw unavailableRootBinary(kind, root, join(root, config.name), 'root is not absolute')
    }
    const path = join(root, config.name)
    try {
      accessSync(path, constants.X_OK)
    } catch {
      throw unavailableRootBinary(kind, root, path, 'binary is missing or not executable')
    }
    return { kind, ...config, source: 'toolchain-root', path, configuredRoot: root }
  }

  // Deliberately identical to the pre-T-07764 bundled resolution.
  return {
    kind,
    ...config,
    source: 'bundled',
    path: resolveHoistedBinary(WORKSPACE_ROOT, config.name),
  }
}

export function brokerDriverToolchainKind(driverKind: string): HrcAspToolchainBinaryKind {
  if (driverKind === 'pi-sdk') return 'harness-broker-pi'
  if (driverKind === 'agent-harness' || driverKind === 'agent-harness-tmux') {
    return 'agent-harness'
  }
  return 'harness-broker'
}

/** Classify an already-selected command without selecting it a second time. */
export function describeAspToolchainCommand(
  kind: HrcAspToolchainBinaryKind,
  path: string,
  env: Record<string, string | undefined> = process.env
): AspToolchainBinarySelection {
  const config = BINARY_CONFIG[kind]
  const override = configuredValue(env, config.envVar)
  if (override === path) return { kind, ...config, source: 'env-override', path }
  const root = configuredValue(env, HRC_ASP_TOOLCHAIN_ROOT_ENV)
  if (root !== undefined && isAbsolute(root) && join(root, config.name) === path) {
    return { kind, ...config, source: 'toolchain-root', path, configuredRoot: root }
  }
  return { kind, ...config, source: 'bundled', path }
}

export function observeAspToolchainHello(
  selection: AspToolchainBinarySelection,
  hello: Omit<HrcAspToolchainHelloObservation, 'observedAt'>
): void {
  helloObservations.set(selection.kind, {
    path: selection.path,
    observation: { ...hello, observedAt: new Date().toISOString() },
  })
}

export function externalToolchainContractDriftDetail(
  selection: AspToolchainBinarySelection
):
  | { remedy: string; toolchainSource: AspToolchainBinarySource; toolchainPath: string }
  | undefined {
  if (selection.source === 'bundled') return undefined
  return {
    remedy:
      'contract drift between resident hrc and external ASP toolchain: pull-deps + restart hrc, or align agent-spaces',
    toolchainSource: selection.source,
    toolchainPath: selection.path,
  }
}

export function projectAspToolchainStatus(
  bundledAspBuild?: PraesidiumBuild | undefined,
  env: Record<string, string | undefined> = process.env
): HrcAspToolchainStatus {
  const configuredRoot = configuredValue(env, HRC_ASP_TOOLCHAIN_ROOT_ENV)
  const binaries = ASP_TOOLCHAIN_BINARY_KINDS.map((kind) => {
    try {
      const selection = resolveAspToolchainBinary(kind, env)
      const observed = helloObservations.get(kind)
      return {
        kind,
        name: selection.name,
        envVar: selection.envVar,
        source: selection.source,
        path: selection.path,
        available: true as const,
        ...(observed?.path === selection.path ? { hello: observed.observation } : {}),
      }
    } catch (error) {
      const config = BINARY_CONFIG[kind]
      const path = configuredRoot === undefined ? config.name : join(configuredRoot, config.name)
      return {
        kind,
        name: config.name,
        envVar: config.envVar,
        source: 'toolchain-root' as const,
        path,
        available: false as const,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
  const toolchainRootActive = binaries.some((entry) => entry.source === 'toolchain-root')
  return {
    ...(configuredRoot !== undefined ? { configuredRoot } : {}),
    toolchainRootActive,
    binaries,
    ...(toolchainRootActive && bundledAspBuild !== undefined ? { bundledAspBuild } : {}),
  }
}
