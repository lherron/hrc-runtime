/**
 * Publish containment: which registries a given node is allowed to publish to.
 *
 * `hrcdev` is a Tart macOS guest hosted on max3 that reaches BOTH its own
 * Verdaccio (`127.0.0.1:4873`) and the shared fleet registry (`mini:4873`).
 * Its plist declares `VERDACCIO_REGISTRY=http://127.0.0.1:4873/` as the
 * containment guard, but that value never reaches an agent shell: the harness
 * composes a fresh env for the agent process, so every seat on the guest ran
 * `just install` straight into the SHARED registry (T-07959, found while
 * verifying T-07958 — that deploy published 11 guest-built packages as
 * `0.1.0-dev.20260903203541 --tag latest` to `http://mini:4873/`).
 *
 * The fix is not to plumb the env key further down the spawn chain — ambient
 * env never carries intent. The guard belongs at the publish boundary and is
 * keyed on node IDENTITY, which is durable operator config rather than
 * inherited process state.
 *
 * There is deliberately no override flag. A guest that must genuinely publish
 * to the shared registry is an operator lifecycle decision made by editing the
 * guest's declared nodeId, from an operator shell — the same place its identity
 * is decided for every other purpose.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { resolveStateRoot } from 'hrc-core'

/**
 * Nodes whose publishes must stay on loopback.
 *
 * A list, not a predicate over config, because containment is a claim about a
 * specific machine's role in this estate: hrcdev exists to be rebuilt and
 * broken, so nothing it mints may become a version the rest of the fleet
 * installs. Adding a node here is a deliberate edit, and removing one is too.
 */
export const CONTAINED_NODE_IDS: readonly string[] = ['hrcdev']

/** The registry a contained node is expected to publish to. */
export const LOOPBACK_REGISTRY_URL = 'http://127.0.0.1:4873/'

export const FEDERATION_CONFIG_ENV = 'HRC_PEER_CONFIG_FILE'
export const FEDERATION_CONFIG_BASENAME = 'federation.json'

/** Where a resolved nodeId came from, so a refusal can cite its own evidence. */
export type NodeIdSource = 'daemon-status' | 'federation-config' | 'hostname'

export type LocalNodeIdentity = {
  nodeId: string
  source: NodeIdSource
  /** Human-readable description of the surface consulted. */
  detail: string
}

export function isLoopbackRegistryUrl(registryUrl: string): boolean {
  let host: string
  try {
    host = new URL(registryUrl).hostname
  } catch {
    return false
  }
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (bare === 'localhost' || bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  // The whole 127.0.0.0/8 loopback block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

export function federationConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env[FEDERATION_CONFIG_ENV]?.trim()
  if (configured) return configured
  try {
    return join(resolveStateRoot(), FEDERATION_CONFIG_BASENAME)
  } catch {
    return undefined
  }
}

/**
 * The `nodeId` a running daemon reports, or undefined when it cannot be asked.
 *
 * Bounded: a publish runs inside `just install`, and an unbounded probe against
 * a wedged daemon would wedge every install on every node rather than only
 * degrading this one check.
 */
function nodeIdFromDaemonStatus(): string | undefined {
  const result = spawnSync('hrc', ['server', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0 || !result.stdout) return undefined
  try {
    const status = JSON.parse(result.stdout) as { node?: { nodeId?: unknown } }
    const nodeId = status.node?.nodeId
    return typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : undefined
  } catch {
    return undefined
  }
}

/**
 * The `nodeId` DECLARED in this node's federation config.
 *
 * Only the one field is read. The daemon's own parser (`federation-config.ts`)
 * validates the whole document at startup; re-implementing it here would put a
 * second, drifting authority on the estate's identity file.
 */
export function declaredNodeIdFromConfigContent(content: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const nodeId = (parsed as Record<string, unknown>)['nodeId']
  return typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : undefined
}

function nodeIdFromFederationConfig(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  return declaredNodeIdFromConfigContent(content)
}

/**
 * Containment fallback when neither the daemon nor its config can answer.
 *
 * Mirrors `deriveNodeIdFromHostname` in hrc-server (short name, lowercased) but
 * is deliberately NOT an identity source: nothing keys ledger or registry rows
 * off this value. It exists so a guest with its daemon down and its config
 * missing still refuses, instead of taking the absence as permission.
 */
export function deriveContainmentNodeIdFromHostname(raw: string = hostname()): string {
  return (raw.trim().split('.')[0] ?? '').toLowerCase()
}

export function resolveLocalNodeIdentity(
  probes: {
    daemonStatus?: () => string | undefined
    federationConfig?: () => { path: string | undefined; nodeId: string | undefined }
    hostnameNodeId?: () => string
  } = {}
): LocalNodeIdentity {
  const fromDaemon = (probes.daemonStatus ?? nodeIdFromDaemonStatus)()
  if (fromDaemon !== undefined) {
    return { nodeId: fromDaemon, source: 'daemon-status', detail: 'hrc server status --json' }
  }

  const configProbe =
    probes.federationConfig ??
    (() => {
      const path = federationConfigPath()
      return { path, nodeId: nodeIdFromFederationConfig(path) }
    })
  const config = configProbe()
  if (config.nodeId !== undefined) {
    return {
      nodeId: config.nodeId,
      source: 'federation-config',
      detail: `declared "nodeId" in ${config.path ?? FEDERATION_CONFIG_BASENAME}`,
    }
  }

  const derived = (probes.hostnameNodeId ?? deriveContainmentNodeIdFromHostname)()
  return {
    nodeId: derived,
    source: 'hostname',
    detail: 'hostname (daemon down, no declared nodeId)',
  }
}

export type ContainmentRefusalInput = {
  identity: LocalNodeIdentity
  registryUrl: string
  /** Path an operator would edit to change this node's identity. */
  configPath?: string | undefined
  containedNodeIds?: readonly string[]
}

/**
 * The refusal text, or undefined when the publish is allowed.
 *
 * Pure so the message a node actually prints can be asserted without a node.
 */
export function describePublishContainmentRefusal(
  input: ContainmentRefusalInput
): string | undefined {
  const contained = input.containedNodeIds ?? CONTAINED_NODE_IDS
  if (!contained.includes(input.identity.nodeId)) return undefined
  if (isLoopbackRegistryUrl(input.registryUrl)) return undefined

  const configPath = input.configPath ?? FEDERATION_CONFIG_BASENAME
  return [
    `PUBLISH REFUSED: node "${input.identity.nodeId}" may publish only to a loopback registry, but this publish targets ${input.registryUrl}.`,
    '',
    `Node identity resolved from ${input.identity.detail}.`,
    '',
    `${input.identity.nodeId} is a disposable guest that also reaches the shared fleet registry. A publish from it mints a guest-built version that every other node then installs from a registry nobody expected it to reach.`,
    '',
    'For a loopback publish, re-run with the guest registry named explicitly:',
    `  VERDACCIO_REGISTRY=${LOOPBACK_REGISTRY_URL} just install`,
    `  VERDACCIO_REGISTRY=${LOOPBACK_REGISTRY_URL} bun scripts/publish-local-verdaccio.ts <same arguments>`,
    '',
    `There is no override flag. If this node must genuinely publish to ${input.registryUrl}, that is an operator lifecycle decision: change its declared "nodeId" in ${configPath} from an operator shell and restart the daemon.`,
  ].join('\n')
}

/** Throws the refusal when this node may not publish to `registryUrl`. */
export function assertPublishContainment(registryUrl: string): void {
  const identity = resolveLocalNodeIdentity()
  const refusal = describePublishContainmentRefusal({
    identity,
    registryUrl,
    configPath: federationConfigPath(),
  })
  if (refusal !== undefined) throw new Error(refusal)
}
