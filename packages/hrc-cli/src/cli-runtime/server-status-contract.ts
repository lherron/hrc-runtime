import type { ServerRuntimeStatus } from './server-status.js'

/**
 * The published shape of `hrc server status --json`.
 *
 * `collectServerRuntimeStatus` produces one object; `formatServerRuntimeStatus`
 * renders it for a terminal and `printJson` serializes the very same object. So
 * the two renders cannot carry different *values* — but they carry different
 * *names*, and that is what bit T-07646: activation scripts read `.nodeId`,
 * `.release.id`, `.hrcBuild.version` and `.sourceCommit`, and jq answered `null`
 * for all four because no key has ever lived at those paths. `null` from jq
 * means "absent" just as loudly as it means "null", so a wrong path looks
 * exactly like a broken daemon.
 *
 * This table is the antidote and the single source of truth for both:
 *   - the parity test, which walks it in both directions against one status
 *     object (every printed line is a documented path; every documented path
 *     resolves, with the same value the line shows), and
 *   - `hrc info`, which publishes the activation subset with the wrong path
 *     printed beside the right one.
 *
 * Adding a line to `formatServerRuntimeStatus` without adding it here fails the
 * parity test. That is the point.
 */
export type ServerStatusContractEntry = {
  /** The label exactly as `formatServerRuntimeStatus` prints it, sans colon. */
  label: string
  /**
   * Paths into the `--json` document this line is rendered from, most
   * significant first. `foo[].bar` reads `bar` off every element of array
   * `foo`.
   */
  paths: readonly string[]
  /**
   * The line renders across several output lines (peer tables), so a value is
   * asserted against the whole document rather than one line.
   */
  multiline?: boolean
  /**
   * Paths whose value the human render summarizes rather than prints, so it
   * cannot be matched literally. Kept explicit: the default is that a string or
   * number in the JSON appears verbatim in the line.
   */
  summarized?: readonly string[]
  /**
   * Paths whose absence is legitimate — a field the daemon genuinely may not
   * have (no pid), or an arm of a discriminated union the document is not in
   * (`release.releaseId` exists only in `atomic` mode). Absence is tolerated;
   * the value is still held to the render when it IS there.
   */
  optional?: readonly string[]
}

export const SERVER_STATUS_CONTRACT: readonly ServerStatusContractEntry[] = [
  { label: 'running', paths: ['running'] },
  { label: 'status', paths: ['status'] },
  { label: 'pid', paths: ['pid'], optional: ['pid'] },
  { label: 'pid alive', paths: ['pidAlive'] },
  { label: 'pid file', paths: ['pidPath'] },
  { label: 'runtime root', paths: ['runtimeRoot'] },
  { label: 'state root', paths: ['stateRoot'] },
  { label: 'socket', paths: ['socketPath', 'socketResponsive'] },
  {
    label: 'api health',
    paths: ['apiHealth.ok', 'apiHealth.error'],
    // Present only on a failed probe, where the render does print it.
    optional: ['apiHealth.error'],
  },
  { label: 'lock', paths: ['lockPath', 'lockExists'] },
  {
    label: 'tmux',
    paths: ['tmux.available', 'tmux.running', 'tmux.sessionCount', 'tmux.error'],
    // Rendered as a phrase ("available (not running)"), which drops the session
    // count when there are none and the error when tmux is usable anyway.
    summarized: ['tmux.sessionCount', 'tmux.error'],
    optional: ['tmux.error'],
  },
  { label: 'tmux socket', paths: ['tmuxSocketPath'] },
  { label: 'cwd', paths: ['cwd'] },
  { label: 'binary', paths: ['binaryPath'] },
  { label: 'package', paths: ['packagePath'] },
  {
    label: 'release',
    paths: ['release.mode', 'release.releaseId'],
    // An `unmanaged` release has no id; `release.mode` is the discriminator
    // an activation script must read first.
    optional: ['release.releaseId'],
  },
  { label: 'installed', paths: ['release.runningEqualsInstalled'] },
  { label: 'HRC build', paths: ['release.hrcBuild.setVersion', 'release.hrcBuild.sourceCommit'] },
  { label: 'ASP build', paths: ['release.aspBuild.setVersion', 'release.aspBuild.sourceCommit'] },
  { label: 'nodeId', paths: ['node.nodeId', 'node.nodeIdProvenance'] },
  { label: 'node mode', paths: ['node.mode'] },
  { label: 'node config', paths: ['node.configPath', 'node.configExists'] },
  {
    label: 'peers',
    paths: ['node.peerCount', 'node.peers[].nodeId', 'node.peers[].endpoint'],
    multiline: true,
  },
  {
    label: 'peer health',
    paths: ['peerHealth[].nodeId', 'peerHealth[].state', 'peerHealth[].latencyMs'],
    multiline: true,
  },
  { label: 'uptime', paths: ['api.uptime'] },
  { label: 'started', paths: ['api.startedAt'] },
  { label: 'apiVersion', paths: ['api.apiVersion'] },
  { label: 'error', paths: ['error'] },
]

/**
 * The paths activation scripts actually need, published by `hrc info`.
 *
 * `wrongPath` is the shorter name someone reached for and got `null` from.
 * Printing it beside the real path is the whole remedy: the guess is corrected
 * in the runbook instead of during a rollout.
 */
export type ActivationContractPath = {
  path: string
  summary: string
  /** The path that does NOT exist, and silently answers `null`. */
  wrongPath?: string
}

export const ACTIVATION_CONTRACT: readonly ActivationContractPath[] = [
  { path: 'node.nodeId', summary: "this node's id", wrongPath: '.nodeId' },
  { path: 'release.mode', summary: '"atomic" | "unmanaged" — assert this first' },
  { path: 'release.releaseId', summary: 'installed atomic release', wrongPath: '.release.id' },
  {
    path: 'release.hrcBuild.sourceCommit',
    summary: 'running HRC commit',
    wrongPath: '.sourceCommit',
  },
  {
    path: 'release.hrcBuild.setVersion',
    summary: 'running HRC set version',
    wrongPath: '.hrcBuild.version',
  },
  {
    path: 'release.processStartedAt',
    summary: 'when the running process started',
    wrongPath: '.processStartedAt',
  },
  {
    path: 'release.runningEqualsInstalled',
    summary: 'true when running == installed release',
  },
]

/** Resolve a contract path, returning every leaf it addresses. */
export function resolveContractPath(status: unknown, path: string): unknown[] {
  let cursors: unknown[] = [status]
  for (const rawSegment of path.split('.')) {
    const isArray = rawSegment.endsWith('[]')
    const key = isArray ? rawSegment.slice(0, -2) : rawSegment
    const next: unknown[] = []
    for (const cursor of cursors) {
      if (cursor === null || typeof cursor !== 'object') continue
      const value = (cursor as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (isArray) {
        if (Array.isArray(value)) next.push(...value)
        continue
      }
      next.push(value)
    }
    cursors = next
  }
  return cursors
}

export type ParityViolation = {
  kind: 'undocumented-line' | 'unresolved-path' | 'value-not-rendered'
  label: string
  path?: string
  detail: string
}

/** Labels a line's own indentation marks as a continuation of the line above. */
const TOP_LEVEL_LINE = /^ {2}([^ ][^:]*):/

/**
 * Compare a rendered `formatServerRuntimeStatus` string against the `--json`
 * serialization of the *same* status object.
 *
 * Both directions matter. A line with no contract entry means the human render
 * shows something the JSON contract does not name; a documented path that does
 * not resolve — on a status object whose line WAS printed — means the JSON has
 * dropped a field the render still claims.
 */
export function findServerStatusParityViolations(
  status: ServerRuntimeStatus,
  rendered: string
): ParityViolation[] {
  const violations: ParityViolation[] = []
  const lines = rendered.split('\n')
  const linesByLabel = new Map<string, string[]>()
  for (const line of lines) {
    const match = TOP_LEVEL_LINE.exec(line)
    if (!match?.[1]) continue
    const label = match[1]
    linesByLabel.set(label, [...(linesByLabel.get(label) ?? []), line])
  }

  for (const label of linesByLabel.keys()) {
    if (SERVER_STATUS_CONTRACT.some((entry) => entry.label === label)) continue
    violations.push({
      kind: 'undocumented-line',
      label,
      detail: `the human render prints "${label}:" but no contract entry names its JSON path`,
    })
  }

  // JSON.stringify is what the CLI actually ships, so resolve against the
  // serialized document: a key holding `undefined` is a key the caller never
  // sees, and must not pass as present.
  const serialized: unknown = JSON.parse(JSON.stringify(status))

  for (const entry of SERVER_STATUS_CONTRACT) {
    const entryLines = linesByLabel.get(entry.label)
    if (!entryLines) continue
    const haystack = entry.multiline === true ? rendered : entryLines.join('\n')

    for (const path of entry.paths) {
      const values = resolveContractPath(serialized, path)
      if (values.length === 0) {
        if (entry.optional?.includes(path) === true) continue
        violations.push({
          kind: 'unresolved-path',
          label: entry.label,
          path,
          detail: `"${entry.label}:" is printed, but ${path} is absent from the JSON document`,
        })
        continue
      }
      if (entry.summarized?.includes(path) === true) continue
      for (const value of values) {
        if (typeof value !== 'string' && typeof value !== 'number') continue
        if (haystack.includes(String(value))) continue
        violations.push({
          kind: 'value-not-rendered',
          label: entry.label,
          path,
          detail: `${path} is ${JSON.stringify(value)} in the JSON, but that value is absent from the "${entry.label}:" output`,
        })
      }
    }
  }

  return violations
}

/** The `hrc info` block that publishes the activation contract. */
export function renderServerStatusJsonContract(): string {
  const width = Math.max(...ACTIVATION_CONTRACT.map((entry) => entry.path.length))
  const rows = ACTIVATION_CONTRACT.map((entry) => {
    const wrong = entry.wrongPath === undefined ? '' : ` (NOT ${entry.wrongPath})`
    return `    ${entry.path.padEnd(width + 2)}${entry.summary}${wrong}`
  })
  return `SERVER STATUS JSON
  hrc server status --json is one document, and every path below is also printed by the
  human render. Nothing is emitted at the top level under a shorter name — jq answers
  null for a path that does not exist, so a typo reads exactly like a dead daemon.
${rows.join('\n')}
  Assert release.mode == "atomic" before reading any other release.* path, and read with
  jq -e: it exits nonzero on a path that does not exist, where jq -r prints a bare null
  no different from a real one. That is the whole failure this contract exists to end.`
}
