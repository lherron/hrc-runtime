/**
 * Node-local federation config (federation spec §3 identity, §6 peer config).
 *
 * One operator-managed file per node carries both this node's identity and its
 * static peer table:
 *
 * ```json
 * {
 *   "nodeId": "lab",
 *   "peers": {
 *     "svc": { "endpoint": "https://svc.example.ts.net:8443", "token": "..." }
 *   }
 * }
 * ```
 *
 * Properties, all deliberate:
 *
 * - **Node-local, never git-synced.** It holds bearer tokens. Expected mode is
 *   `0600`; a looser mode produces a startup warning naming the file.
 * - **Single source of identity.** There is no environment override for
 *   `nodeId`. Changing a node's identity is a rebind-class operation, not an env
 *   tweak, and env precedence on identity config has burned this estate before.
 *   Only the file location is env-selectable (`HRC_PEER_CONFIG_FILE`).
 * - **Absent file is valid single-node mode**, and still yields a deterministic
 *   valid nodeId derived from the hostname (provenance `derived`).
 * - **Malformed file is a visible startup diagnostic naming the problem** — it
 *   never degrades silently to single-node mode, because silently forgetting
 *   who you are is worse than refusing to boot.
 *
 * This is transport plumbing, not placement policy (§6). Nothing here decides
 * where a scope lives.
 *
 * An optional top-level `registry.bind` enables F0's narrow registry-only
 * listener. The general peer protocol still lands in F1.
 */

import { readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { type NodeId, describeNodeIdViolation, isReservedNodeId, parseNodeId } from './node-id.js'
import { PeerToken } from './peer-token.js'
import { type RegistryListenerConfig, parseRegistryBind } from './registry-bind.js'

export const HRC_PEER_CONFIG_FILE_ENV = 'HRC_PEER_CONFIG_FILE'
export const FEDERATION_CONFIG_BASENAME = 'federation.json'

/** Mode bits that must not be set on a file holding bearer tokens. */
const GROUP_OTHER_MODE_MASK = 0o077
export const EXPECTED_FEDERATION_CONFIG_MODE = 0o600

/** Last-resort nodeId when a hostname carries nothing usable. */
const FALLBACK_DERIVED_NODE_ID = 'unknown-node'

export type PeerEntry = {
  readonly nodeId: NodeId
  readonly endpoint: string
  readonly token: PeerToken
}

export type NodeIdProvenance = 'declared' | 'derived'

export type FederationConfig = {
  /** Resolved identity of this node. Always present and always valid. */
  readonly nodeId: NodeId
  /** `declared` = read from the config file; `derived` = computed from hostname. */
  readonly nodeIdProvenance: NodeIdProvenance
  /** Path consulted, whether or not it existed. */
  readonly sourcePath: string
  /** False when the file was absent (single-node mode). */
  readonly sourceExists: boolean
  readonly peers: ReadonlyMap<NodeId, PeerEntry>
  /** Present only on the node serving F0's narrow binding registry endpoint. */
  readonly registry?: RegistryListenerConfig | undefined
  /** Non-fatal startup diagnostics (e.g. permissive file mode). */
  readonly warnings: readonly string[]
}

export function isSingleNodeMode(config: FederationConfig): boolean {
  return config.peers.size === 0
}

/**
 * Derives a deterministic, grammar-valid nodeId from the machine hostname.
 *
 * Semantics, chosen against §3 (grammar) and recorded here because the spec
 * does not describe derivation:
 *
 * 1. Take `os.hostname()`, trim, and drop everything after the first dot — the
 *    mDNS `.local` suffix on macOS would otherwise put the reserved sentinel
 *    inside every derived id, and the short name is the stable part anyway.
 * 2. Lowercase it. Hostnames are case-insensitive, so this keeps derivation
 *    deterministic across the ways an OS may report the same name.
 * 3. Replace each character outside `[A-Za-z0-9._-]` with `-`, then truncate to
 *    64 characters to satisfy the §3 token grammar.
 * 4. If the result is empty or reserved, fall back to `unknown-node`.
 *
 * A derived id is a single-node convenience, not a roster identity: it will not
 * match the §4 roster ids (`svc`, `lab`, `max3`). Any node with peers therefore
 * must declare its nodeId — see `resolveFederationConfig`.
 */
export function deriveNodeIdFromHostname(rawHostname: string = hostname()): NodeId {
  const shortName = rawHostname.trim().split('.')[0] ?? ''
  const sanitized = shortName
    .toLowerCase()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 64)

  if (sanitized.length === 0 || isReservedNodeId(sanitized)) {
    return FALLBACK_DERIVED_NODE_ID as NodeId
  }
  return sanitized as NodeId
}

export function resolveFederationConfigPath(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env[HRC_PEER_CONFIG_FILE_ENV]?.trim()
  if (configured) return configured
  return join(stateRoot, FEDERATION_CONFIG_BASENAME)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates a peer endpoint.
 *
 * Rejects wildcard and unspecified addresses: those are listener *bind*
 * addresses, never a reachable destination, and §6 rejects wildcards day one.
 * Catching it here means the operator learns at startup rather than at the
 * first failed delivery in F1.
 */
function validatePeerEndpoint(endpoint: string, where: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`${where} endpoint is not a valid URL: ${JSON.stringify(endpoint)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `${where} endpoint must use http: or https:, got ${JSON.stringify(url.protocol)}`
    )
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host.length === 0) {
    throw new Error(`${where} endpoint has no host: ${JSON.stringify(endpoint)}`)
  }
  if (host.includes('*') || host === '0.0.0.0' || host === '::') {
    throw new Error(
      `${where} endpoint must name a specific host, not the wildcard/unspecified address ${JSON.stringify(
        url.hostname
      )}`
    )
  }
  return url.toString()
}

type ParsedFile = {
  declaredNodeId: NodeId | undefined
  peers: Map<NodeId, PeerEntry>
  registry: RegistryListenerConfig | undefined
}

/**
 * Parses and validates the config document.
 *
 * Every throw names the file and the specific field at fault — this is the
 * "malformed file produces a visible startup diagnostic naming the problem"
 * requirement, so "invalid config" is never an acceptable message.
 */
export function parseFederationConfigDocument(value: unknown, sourcePath: string): ParsedFile {
  if (!isPlainRecord(value)) {
    throw new Error(`${sourcePath} must contain a JSON object`)
  }

  let declaredNodeId: NodeId | undefined
  if (value['nodeId'] !== undefined) {
    if (typeof value['nodeId'] !== 'string') {
      throw new Error(`${sourcePath} field "nodeId" must be a string`)
    }
    declaredNodeId = parseNodeId(value['nodeId'], `${sourcePath} field "nodeId"`)
  }

  const peers = new Map<NodeId, PeerEntry>()
  const peerTokenOwners = new Map<string, NodeId>()
  if (value['peers'] !== undefined) {
    if (!isPlainRecord(value['peers'])) {
      throw new Error(`${sourcePath} field "peers" must be a JSON object of nodeId to peer entries`)
    }
    for (const [rawPeerId, rawEntry] of Object.entries(value['peers'])) {
      const where = `${sourcePath} peer ${JSON.stringify(rawPeerId)}`
      const violation = describeNodeIdViolation(rawPeerId)
      if (violation !== undefined) {
        throw new Error(`${where} has an invalid nodeId key: ${violation}`)
      }
      const peerId = rawPeerId as NodeId

      if (declaredNodeId !== undefined && peerId === declaredNodeId) {
        throw new Error(`${where} is this node's own nodeId — a node cannot be its own peer`)
      }
      if (!isPlainRecord(rawEntry)) {
        throw new Error(`${where} must be a JSON object with "endpoint" and "token"`)
      }
      if (typeof rawEntry['endpoint'] !== 'string' || rawEntry['endpoint'].trim().length === 0) {
        throw new Error(`${where} is missing a non-empty string "endpoint"`)
      }
      if (typeof rawEntry['token'] !== 'string' || rawEntry['token'].length === 0) {
        throw new Error(`${where} is missing a non-empty string "token"`)
      }
      const priorTokenOwner = peerTokenOwners.get(rawEntry['token'])
      if (priorTokenOwner !== undefined) {
        throw new Error(
          `${where} reuses the bearer token configured for peer ${JSON.stringify(priorTokenOwner)}; each peer requires a distinct token`
        )
      }
      peerTokenOwners.set(rawEntry['token'], peerId)

      peers.set(peerId, {
        nodeId: peerId,
        endpoint: validatePeerEndpoint(rawEntry['endpoint'].trim(), where),
        token: new PeerToken(rawEntry['token']),
      })
    }
  }

  let registry: RegistryListenerConfig | undefined
  if (value['registry'] !== undefined) {
    const where = `${sourcePath} field "registry"`
    if (!isPlainRecord(value['registry'])) {
      throw new Error(`${where} must be a JSON object with "bind"`)
    }
    const rawBind = value['registry']['bind']
    if (typeof rawBind !== 'string' || rawBind.trim().length === 0) {
      throw new Error(`${sourcePath} registry is missing a non-empty string "bind"`)
    }
    registry = parseRegistryBind(rawBind, `${sourcePath} registry`)
  }

  return { declaredNodeId, peers, registry }
}

async function readModeWarning(path: string): Promise<string | undefined> {
  try {
    const stats = await stat(path)
    const mode = stats.mode & 0o777
    if ((mode & GROUP_OTHER_MODE_MASK) !== 0) {
      return `${path} holds peer bearer tokens but is mode ${mode
        .toString(8)
        .padStart(3, '0')}; expected 0600 (run: chmod 600 ${path})`
    }
  } catch {
    // Mode is advisory; an unreadable stat is already covered by the read path.
  }
  return undefined
}

export type ResolveFederationConfigOptions = {
  stateRoot: string
  env?: NodeJS.ProcessEnv | undefined
  /** Overrides hostname derivation in tests. */
  hostnameProvider?: (() => string) | undefined
}

/**
 * Loads the federation config for daemon startup.
 *
 * Absent file → single-node mode with a derived nodeId. Malformed file →
 * throws a diagnostic naming the file and the field.
 */
export async function resolveFederationConfig(
  options: ResolveFederationConfigOptions
): Promise<FederationConfig> {
  const env = options.env ?? process.env
  const sourcePath = resolveFederationConfigPath(options.stateRoot, env)
  const derive = () => deriveNodeIdFromHostname(options.hostnameProvider?.() ?? hostname())

  let raw: string
  try {
    raw = await readFile(sourcePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        nodeId: derive(),
        nodeIdProvenance: 'derived',
        sourcePath,
        sourceExists: false,
        peers: new Map(),
        warnings: [],
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`federation config ${sourcePath} could not be read: ${message}`, {
      cause: error,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`federation config ${sourcePath} is not valid JSON: ${message}`, {
      cause: error,
    })
  }

  const { declaredNodeId, peers, registry } = parseFederationConfigDocument(parsed, sourcePath)

  // A derived id is a hostname artifact, not a roster identity — it will not
  // match the §4 roster. Letting a peered node run on one would key ledger and
  // registry rows to a name no other node agrees on, so require a declaration
  // exactly when it starts to matter.
  if (declaredNodeId === undefined && peers.size > 0) {
    throw new Error(
      `federation config ${sourcePath} declares ${peers.size} peer(s) but no "nodeId": a node with peers must declare its own nodeId (a hostname-derived id is valid only in single-node mode). Fix: add a "nodeId" field to ${sourcePath}, e.g. {"nodeId": "lab", "peers": {...}}`
    )
  }
  if (declaredNodeId === undefined && registry !== undefined) {
    throw new Error(
      `federation config ${sourcePath} registry listener requires a declared "nodeId" (a hostname-derived id is valid only in single-node mode)`
    )
  }

  const warnings: string[] = []
  const modeWarning = await readModeWarning(sourcePath)
  if (modeWarning !== undefined) warnings.push(modeWarning)

  return {
    nodeId: declaredNodeId ?? derive(),
    nodeIdProvenance: declaredNodeId === undefined ? 'derived' : 'declared',
    sourcePath,
    sourceExists: true,
    peers,
    ...(registry === undefined ? {} : { registry }),
    warnings,
  }
}

/**
 * Log/status-safe projection. Endpoints and ids are not secret; tokens are
 * absent by construction rather than by redaction, so this shape can be logged,
 * returned over the control socket, or put in an event payload freely.
 */
export function summarizeFederationConfig(config: FederationConfig): {
  nodeId: string
  nodeIdProvenance: NodeIdProvenance
  mode: 'single-node' | 'federated'
  configPath: string
  configExists: boolean
  peerCount: number
  peers: { nodeId: string; endpoint: string }[]
} {
  return {
    nodeId: config.nodeId,
    nodeIdProvenance: config.nodeIdProvenance,
    mode: isSingleNodeMode(config) ? 'single-node' : 'federated',
    configPath: config.sourcePath,
    configExists: config.sourceExists,
    peerCount: config.peers.size,
    peers: [...config.peers.values()].map((peer) => ({
      nodeId: peer.nodeId,
      endpoint: peer.endpoint,
    })),
  }
}
