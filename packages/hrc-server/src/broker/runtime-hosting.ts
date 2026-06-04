/**
 * T-01872 (T-01868 / T-01862 Ph1) — broker runtime-hosting state model.
 *
 * This is the migration CHOKE POINT for the leased-tmux durability effort.
 * It models the three INDEPENDENT axes of a harness-broker runtime:
 *
 *   endpoint     — HOW HRC talks to the broker (stdio pipe vs durable unix socket)
 *   substrate    — WHERE the broker process lives (daemon child vs leased tmux session)
 *   presentation — WHETHER a human can attach a TUI (none vs tmux-tui)
 *
 * Crucially these axes are derived from the PERSISTED broker hosting facts, never
 * from `runtime.transport`. `transport` must NOT be used as a durability or
 * attachability proxy anywhere in this module (spec §9.1, §10.1).
 *
 * G2 (daedalus): parseBrokerRuntimeHostingState reads BOTH serialization shapes
 * and resolves them to the same logical BrokerRuntimeHostingState —
 *   (a) the current FLAT T-01801/T-01812 persisted shape: broker.endpoint +
 *       broker.brokerWindow + broker.tuiWindow + broker.generation at the broker
 *       root (BrokerWindowView shape, NO substrate/presentation keys), and
 *   (b) the NEW normalized shape: broker.{endpoint,substrate,presentation}.
 *
 * G4 (daedalus): brokerLeaseIdentityMatches requires a matching brokerWindow for
 * EVERY leased substrate, and requires a matching tuiWindow ONLY when
 * presentation.kind === 'tmux-tui'.
 *
 * This phase is PURELY ADDITIVE — it adds the module only. Caller migration
 * (startup-reconcile / sweep / controller) is Ph2–Ph4.
 */

import type { HrcRuntimeSnapshot } from 'hrc-core'

import type { BrokerAttachTokenRef } from './runtime-state'

// ── Canonical internal types (spec §9.1) ──────────────────────────────────────

/** Minimal tmux window identity used to fence stale leases. */
export type TmuxWindowIdentity = {
  sessionId: string
  windowId: string
  paneId: string
}

/** HOW HRC reaches the broker. The same JSON-RPC/NDJSON protocol rides either a
 *  stdio pipe (ephemeral) or a Unix-domain socket (durable, reattachable). */
export type BrokerRuntimeEndpoint =
  | { kind: 'stdio-jsonrpc-ndjson' }
  | {
      kind: 'unix-jsonrpc-ndjson'
      socketPath: string
      attachTokenRef: BrokerAttachTokenRef
      protocolVersion: 'harness-broker/0.2'
    }

/** WHERE the broker process lives. */
export type BrokerRuntimeSubstrate =
  | { kind: 'daemon-child' }
  | {
      kind: 'leased-tmux'
      tmuxSocketPath: string
      sessionName: string
      brokerWindow: TmuxWindowIdentity
      generation: number
      eventLedgerPath: string
    }

/** WHETHER a human can attach a TUI to this runtime. */
export type BrokerRuntimePresentation =
  | { kind: 'none' }
  | {
      kind: 'tmux-tui'
      tuiWindow: TmuxWindowIdentity
      operatorAttachTarget: true
      attachCommand?: string
    }

export type BrokerRuntimeHostingState = {
  endpoint: BrokerRuntimeEndpoint
  substrate: BrokerRuntimeSubstrate
  presentation: BrokerRuntimePresentation
}

/** A live observation of a runtime's tmux lease used to fence stale identities. */
export type BrokerLeaseProbe = {
  tmuxSocketPath: string
  sessionName: string
  brokerWindow: TmuxWindowIdentity
  tuiWindow?: TmuxWindowIdentity
}

// ── low-level extraction helpers ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract a tmux window identity ({sessionId,windowId,paneId}) from any record.
 *  Tolerant of extra fields (e.g. the flat BrokerWindowView carries socketPath,
 *  sessionName, windowName alongside the identity triple). */
function extractTmuxWindowIdentity(value: unknown): TmuxWindowIdentity | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const sessionId = value['sessionId']
  const windowId = value['windowId']
  const paneId = value['paneId']
  if (
    typeof sessionId !== 'string' ||
    typeof windowId !== 'string' ||
    typeof paneId !== 'string'
  ) {
    return undefined
  }
  return { sessionId, windowId, paneId }
}

function parseEndpoint(value: unknown): BrokerRuntimeEndpoint | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const kind = value['kind']
  if (kind === 'stdio-jsonrpc-ndjson') {
    return { kind: 'stdio-jsonrpc-ndjson' }
  }
  if (kind === 'unix-jsonrpc-ndjson') {
    const socketPath = value['socketPath']
    const tokenRef = value['attachTokenRef']
    if (typeof socketPath !== 'string' || !isRecord(tokenRef)) {
      return undefined
    }
    const tokenKind = tokenRef['kind']
    const tokenPath = tokenRef['path']
    if (tokenKind !== 'file' || typeof tokenPath !== 'string') {
      return undefined
    }
    // protocolVersion may sit inside the endpoint (normalized shape) or at the
    // broker root (flat shape); the durable unix endpoint is always 0.2 either
    // way, so we canonicalize to the literal here.
    return {
      kind: 'unix-jsonrpc-ndjson',
      socketPath,
      attachTokenRef: { kind: 'file', path: tokenPath, redacted: true },
      protocolVersion: 'harness-broker/0.2',
    }
  }
  return undefined
}

// ── normalized shape (broker.{substrate,presentation}) ────────────────────────

function parseNormalizedSubstrate(value: unknown): BrokerRuntimeSubstrate | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const kind = value['kind']
  if (kind === 'daemon-child') {
    return { kind: 'daemon-child' }
  }
  if (kind === 'leased-tmux') {
    const tmuxSocketPath = value['tmuxSocketPath']
    const sessionName = value['sessionName']
    const brokerWindow = extractTmuxWindowIdentity(value['brokerWindow'])
    const generation = value['generation']
    if (
      typeof tmuxSocketPath !== 'string' ||
      typeof sessionName !== 'string' ||
      !brokerWindow ||
      typeof generation !== 'number'
    ) {
      return undefined
    }
    const eventLedgerPath =
      typeof value['eventLedgerPath'] === 'string' ? value['eventLedgerPath'] : ''
    return {
      kind: 'leased-tmux',
      tmuxSocketPath,
      sessionName,
      brokerWindow,
      generation,
      eventLedgerPath,
    }
  }
  return undefined
}

function parseNormalizedPresentation(value: unknown): BrokerRuntimePresentation | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const kind = value['kind']
  if (kind === 'none') {
    return { kind: 'none' }
  }
  if (kind === 'tmux-tui') {
    const tuiWindow = extractTmuxWindowIdentity(value['tuiWindow'])
    if (!tuiWindow) {
      return undefined
    }
    const attachCommand =
      typeof value['attachCommand'] === 'string' ? value['attachCommand'] : undefined
    return {
      kind: 'tmux-tui',
      tuiWindow,
      operatorAttachTarget: true,
      ...(attachCommand !== undefined ? { attachCommand } : {}),
    }
  }
  return undefined
}

// ── flat T-01801/T-01812 shape (broker.{brokerWindow,tuiWindow,generation}) ────

/**
 * Infer the substrate from the flat broker block:
 *  - a brokerWindow present at the broker root ⇒ leased-tmux substrate, with
 *    tmuxSocketPath/sessionName/identity read from the BrokerWindowView and
 *    generation read from broker.generation.
 *  - no brokerWindow ⇒ daemon-child substrate (the old stdio/headless path).
 * Returns undefined when a brokerWindow is present but malformed.
 */
function parseFlatSubstrate(
  broker: Record<string, unknown>,
  runtime: HrcRuntimeSnapshot
): BrokerRuntimeSubstrate | undefined {
  const brokerWindowRaw = broker['brokerWindow']
  if (brokerWindowRaw === undefined) {
    return { kind: 'daemon-child' }
  }
  if (!isRecord(brokerWindowRaw)) {
    return undefined
  }
  const tmuxSocketPath = brokerWindowRaw['socketPath']
  const sessionName = brokerWindowRaw['sessionName']
  const brokerWindow = extractTmuxWindowIdentity(brokerWindowRaw)
  if (typeof tmuxSocketPath !== 'string' || typeof sessionName !== 'string' || !brokerWindow) {
    return undefined
  }
  const generation =
    typeof broker['generation'] === 'number'
      ? (broker['generation'] as number)
      : typeof runtime.generation === 'number'
        ? runtime.generation
        : 0
  const eventLedgerPath =
    typeof broker['eventLedgerPath'] === 'string' ? (broker['eventLedgerPath'] as string) : ''
  return {
    kind: 'leased-tmux',
    tmuxSocketPath,
    sessionName,
    brokerWindow,
    generation,
    eventLedgerPath,
  }
}

/**
 * Infer the presentation from the flat broker block:
 *  - a tuiWindow present ⇒ tmux-tui presentation (operator attachable), with the
 *    attachCommand synthesized from the broker window's tmux socket + session.
 *  - no/malformed tuiWindow ⇒ none.
 */
function parseFlatPresentation(broker: Record<string, unknown>): BrokerRuntimePresentation {
  const tuiWindow = extractTmuxWindowIdentity(broker['tuiWindow'])
  if (!tuiWindow) {
    return { kind: 'none' }
  }
  const brokerWindowRaw = broker['brokerWindow']
  let attachCommand: string | undefined
  if (
    isRecord(brokerWindowRaw) &&
    typeof brokerWindowRaw['socketPath'] === 'string' &&
    typeof brokerWindowRaw['sessionName'] === 'string'
  ) {
    attachCommand = `tmux -S ${brokerWindowRaw['socketPath']} attach -t ${brokerWindowRaw['sessionName']}:tui`
  }
  return {
    kind: 'tmux-tui',
    tuiWindow,
    operatorAttachTarget: true,
    ...(attachCommand !== undefined ? { attachCommand } : {}),
  }
}

// ── the choke-point parser ────────────────────────────────────────────────────

/**
 * Parse a runtime's persisted broker hosting facts into the canonical
 * BrokerRuntimeHostingState, accepting BOTH the flat T-01801 shape and the new
 * normalized shape (G2). Returns undefined when there is no parseable broker
 * block (no runtimeStateJson, no broker key, or a malformed endpoint/substrate/
 * presentation combination). This is the SINGLE reading path — every predicate
 * below derives its answer exclusively through here.
 */
export function parseBrokerRuntimeHostingState(
  runtime: HrcRuntimeSnapshot
): BrokerRuntimeHostingState | undefined {
  const stateJson = runtime.runtimeStateJson
  if (!isRecord(stateJson)) {
    return undefined
  }
  const broker = stateJson['broker']
  if (!isRecord(broker)) {
    return undefined
  }

  const endpoint = parseEndpoint(broker['endpoint'])
  if (!endpoint) {
    return undefined
  }

  // Shape detection: the normalized shape carries explicit substrate/presentation
  // keys; the flat shape carries neither (it has brokerWindow/tuiWindow instead).
  const isNormalized = broker['substrate'] !== undefined || broker['presentation'] !== undefined

  if (isNormalized) {
    const substrate = parseNormalizedSubstrate(broker['substrate'])
    if (!substrate) {
      return undefined
    }
    const presentation = parseNormalizedPresentation(broker['presentation'])
    if (!presentation) {
      return undefined
    }
    return { endpoint, substrate, presentation }
  }

  const substrate = parseFlatSubstrate(broker, runtime)
  if (!substrate) {
    return undefined
  }
  const presentation = parseFlatPresentation(broker)
  return { endpoint, substrate, presentation }
}

/**
 * Like parseBrokerRuntimeHostingState but throws when the broker hosting state
 * cannot be parsed. Use at call sites that have already established (e.g. via
 * isHarnessBroker + a durability check) that a hosting state MUST exist.
 */
export function requireBrokerRuntimeHostingState(
  runtime: HrcRuntimeSnapshot
): BrokerRuntimeHostingState {
  const parsed = parseBrokerRuntimeHostingState(runtime)
  if (!parsed) {
    throw new Error(
      `broker runtime hosting state is not parseable for runtime ${runtime.runtimeId}`
    )
  }
  return parsed
}

// ── predicates ────────────────────────────────────────────────────────────────

/** Pure controllerKind check — does NOT require a parseable hosting state. */
export function isHarnessBroker(runtime: HrcRuntimeSnapshot): boolean {
  return runtime.controllerKind === 'harness-broker'
}

/** True iff the broker is reachable over a durable unix socket. IGNORES transport. */
export function hasDurableBrokerEndpoint(runtime: HrcRuntimeSnapshot): boolean {
  return parseBrokerRuntimeHostingState(runtime)?.endpoint.kind === 'unix-jsonrpc-ndjson'
}

/** True iff the broker process lives in a leased tmux session. IGNORES transport. */
export function hasLeasedBrokerSubstrate(runtime: HrcRuntimeSnapshot): boolean {
  return parseBrokerRuntimeHostingState(runtime)?.substrate.kind === 'leased-tmux'
}

/** True iff the runtime's presentation matches the requested kind. */
export function hasBrokerPresentation(
  runtime: HrcRuntimeSnapshot,
  kind: BrokerRuntimePresentation['kind']
): boolean {
  return parseBrokerRuntimeHostingState(runtime)?.presentation.kind === kind
}

/** True iff a human operator can attach a TUI (presentation.kind === 'tmux-tui'). */
export function canOperatorAttach(runtime: HrcRuntimeSnapshot): boolean {
  return parseBrokerRuntimeHostingState(runtime)?.presentation.kind === 'tmux-tui'
}

/** True iff a direct-pane fallback is possible (requires a tmux-tui presentation). */
export function canUseDirectPaneFallback(runtime: HrcRuntimeSnapshot): boolean {
  return parseBrokerRuntimeHostingState(runtime)?.presentation.kind === 'tmux-tui'
}

function identityMatches(a: TmuxWindowIdentity, b: TmuxWindowIdentity | undefined): boolean {
  return (
    b !== undefined &&
    a.sessionId === b.sessionId &&
    a.windowId === b.windowId &&
    a.paneId === b.paneId
  )
}

/**
 * G4: a live probe matches the persisted lease iff
 *  - the runtime has a leased-tmux substrate, AND
 *  - the probe's tmux socket + session name match the substrate, AND
 *  - the probe's brokerWindow identity matches the substrate's brokerWindow
 *    (required for EVERY leased substrate), AND
 *  - when presentation.kind === 'tmux-tui', the probe ALSO carries a tuiWindow
 *    whose identity matches presentation.tuiWindow. For presentation.none, the
 *    tuiWindow is neither required nor consulted.
 */
export function brokerLeaseIdentityMatches(
  runtime: HrcRuntimeSnapshot,
  probe: BrokerLeaseProbe
): boolean {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (!hosting || hosting.substrate.kind !== 'leased-tmux') {
    return false
  }
  const substrate = hosting.substrate
  if (
    probe.tmuxSocketPath !== substrate.tmuxSocketPath ||
    probe.sessionName !== substrate.sessionName
  ) {
    return false
  }
  if (!identityMatches(substrate.brokerWindow, probe.brokerWindow)) {
    return false
  }
  if (hosting.presentation.kind === 'tmux-tui') {
    if (!identityMatches(hosting.presentation.tuiWindow, probe.tuiWindow)) {
      return false
    }
  }
  return true
}
