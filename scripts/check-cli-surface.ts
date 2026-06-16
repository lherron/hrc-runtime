#!/usr/bin/env bun
/**
 * check-cli-surface — self-describing surface conformance for the hrc + hrcchat CLIs.
 *
 * agent-enablement toolkit §10-D (axis TD) + §7/§5 carrier-health (fail-when-stale).
 * Catalog: archagent/agent-enablement/catalog/typescript/discovery/surface-conformance.
 *
 * The drift this kills: hand-maintained help/info is a `lie-when-stale` carrier. When the CLI
 * surface changes (a command renamed/removed, a flag dropped) and the curated text doesn't, an
 * agent obeys confident-but-false help and misfires. This gate binds the curated text to the live
 * Commander registry:
 *
 *   1. ROSTER COMPLETENESS — every visible top-level command appears in that CLI's generated
 *      `info` COMMANDS roster (guards against the generator being bypassed / a command going
 *      undocumented; this is the class that dropped `turn` from `hrcchat info`).
 *   2. COMMAND-PATH RESOLUTION — every binary-prefixed `hrc <path>` / `hrcchat <path>` token in the
 *      curated prose + usage reference resolves to a real registered command/subcommand.
 *   3. FLAG RESOLUTION — every `--long` flag adjacent to such a token resolves to that CLI's
 *      registered long-option set.
 *
 * Exit 0 = conformant. Exit 1 = drift (with teaching diagnostics). The generated rosters mean
 * direction (1) holds by construction; (2)/(3) cover the hand-curated prose that generation can't.
 */

import type { Command } from 'commander'

import { buildProgram as buildHrcProgram } from '../packages/hrc-cli/src/cli/build-program.ts'
import {
  USAGE_TEXT as HRC_USAGE_TEXT,
  buildInfoText as buildHrcInfoText,
} from '../packages/hrc-cli/src/cli/usage.ts'
import { buildInfoText as buildHrcchatInfoText } from '../packages/hrcchat-cli/src/commands/info.ts'
import { program as hrcchatProgram } from '../packages/hrcchat-cli/src/main.ts'

// ───────────────────────── registry model ─────────────────────────

type Registry = {
  bin: string
  root: Command
  /** All long-option flags across the whole command tree + global options. */
  longOptions: Set<string>
  /** Visible (non-hidden, non-`help`) top-level command names — the completeness target. */
  visibleTop: string[]
}

function isGroup(command: Command): boolean {
  // A pure group has subcommands but no own action handler → a subcommand is required.
  return (
    command.commands.length > 0 &&
    !(command as unknown as { _actionHandler?: unknown })._actionHandler
  )
}

function collectLongOptions(command: Command, into: Set<string>): void {
  for (const option of command.options) {
    if (option.long) into.add(option.long)
  }
  for (const child of command.commands) collectLongOptions(child, into)
}

function buildRegistry(bin: string, root: Command): Registry {
  const longOptions = new Set<string>()
  collectLongOptions(root, longOptions)
  // Commander built-ins, present on every command but not in `.options`.
  longOptions.add('--help')
  longOptions.add('--version')
  const visibleTop = root
    .createHelp()
    .visibleCommands(root)
    .map((command) => command.name())
    .filter((name) => name !== 'help')
  return { bin, root, longOptions, visibleTop }
}

// ───────────────────────── token extraction ─────────────────────────

const BARE_WORD = /^[a-z][a-z0-9-]*$/

/**
 * A "command-shaped" token marks the segment as a runnable example (vs. prose that merely mentions
 * the binary). It is a flag, a target handle (`@`/`~`), a placeholder (`<…>`/`[…]`), or one of the
 * HRC selector prefixes. This keeps prose like "Use hrc to control HRC" from being read as a claim.
 */
function isCommandShaped(token: string): boolean {
  return (
    /^--[a-z]/.test(token) ||
    token.includes('@') ||
    token.includes('~') ||
    /^[<[]/.test(token) ||
    /^(runtime|host|session|scope|msg|seq):/.test(token)
  )
}

/** A binary-prefixed example occurrence, scoped to one CLI. */
type Claim = {
  bin: string
  source: string
  line: number
  /** Command/arg tokens after the binary word. */
  pathTokens: string[]
  /** `--long` flags appearing in the same segment. */
  flags: string[]
}

function cleanToken(raw: string): string {
  return raw.replace(/^[`'"(]+/, '').replace(/[`'".,)]+$/, '')
}

/** Extract every `hrc …` / `hrcchat …` claim from a curated text block. */
function extractClaims(source: string, text: string): Claim[] {
  const claims: Claim[] = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const hits: { bin: string; at: number }[] = []
    for (const match of line.matchAll(/\b(hrcchat|hrc)\b/g)) {
      hits.push({ bin: match[1], at: match.index })
    }

    hits.forEach((hit, hitIndex) => {
      const end = hitIndex + 1 < hits.length ? hits[hitIndex + 1].at : line.length
      const segment = line.slice(hit.at + hit.bin.length, end)
      const rawTokens = segment.split(/\s+/).filter(Boolean)
      const pathTokens: string[] = []
      const flags: string[] = []
      for (const raw of rawTokens) {
        const flagMatches = raw.match(/--[a-z][a-z0-9-]*/g)
        if (flagMatches) {
          flags.push(...flagMatches)
          continue
        }
        pathTokens.push(cleanToken(raw))
      }
      // Only a segment carrying a command-shaped token is a runnable example; otherwise it's prose
      // that happens to mention the binary name (e.g. "Use hrc to control HRC").
      if (flags.length === 0 && !pathTokens.some(isCommandShaped)) return
      claims.push({ bin: hit.bin, source, line: index + 1, pathTokens, flags })
    })
  })
  return claims
}

/**
 * Parse the hrc `USAGE_TEXT` "Commands:" block, where lines are `  <command path> [args/flags]
 * description` with NO binary prefix. Each 2-space-indented, lowercase-leading line is one hrc
 * command entry; deeper-indented continuation/description lines are skipped.
 */
function extractUsageClaims(source: string, text: string): Claim[] {
  const claims: Claim[] = []
  text.split('\n').forEach((line, index) => {
    if (!/^ {2}[a-z]/.test(line)) return // command entries start at exactly 2 spaces
    const tokens = line.trim().split(/\s+/).filter(Boolean)
    const pathTokens: string[] = []
    const flags: string[] = []
    for (const raw of tokens) {
      const flagMatches = raw.match(/--[a-z][a-z0-9-]*/g)
      if (flagMatches) flags.push(...flagMatches)
      else pathTokens.push(cleanToken(raw))
    }
    claims.push({ bin: 'hrc', source, line: index + 1, pathTokens, flags })
  })
  return claims
}

// ───────────────────────── resolution ─────────────────────────

type Finding = {
  source: string
  line: number
  kind: 'unknown-command' | 'unknown-subcommand' | 'unknown-flag' | 'undocumented-command'
  token: string
  detail: string
}

/** Resolve a claim's command path against the registry; returns the leaf node + a finding if drift. */
function resolvePath(registry: Registry, claim: Claim): Finding | null {
  let node: Command = registry.root
  const consumed: string[] = []
  for (const token of claim.pathTokens) {
    if (!BARE_WORD.test(token)) break // an argument/placeholder/selector → end of command path
    const child = node.commands.find((command) => command.name() === token)
    if (child) {
      consumed.push(token)
      node = child
      continue
    }
    if (consumed.length === 0) {
      return {
        source: claim.source,
        line: claim.line,
        kind: 'unknown-command',
        token: `${claim.bin} ${token}`,
        detail: `'${token}' is not a registered ${claim.bin} command`,
      }
    }
    if (isGroup(node)) {
      return {
        source: claim.source,
        line: claim.line,
        kind: 'unknown-subcommand',
        token: `${claim.bin} ${consumed.join(' ')} ${token}`,
        detail: `'${token}' is not a subcommand of '${claim.bin} ${consumed.join(' ')}'`,
      }
    }
    break // node has an action; this token is a positional argument → fine
  }
  return null
}

function resolveFlags(registry: Registry, claim: Claim): Finding[] {
  const findings: Finding[] = []
  for (const flag of claim.flags) {
    if (!registry.longOptions.has(flag)) {
      findings.push({
        source: claim.source,
        line: claim.line,
        kind: 'unknown-flag',
        token: `${claim.bin} … ${flag}`,
        detail: `'${flag}' is not a registered ${claim.bin} option`,
      })
    }
  }
  return findings
}

// ───────────────────────── checks ─────────────────────────

function checkClaims(registries: Record<string, Registry>, claims: Claim[]): Finding[] {
  const findings: Finding[] = []
  for (const claim of claims) {
    const registry = registries[claim.bin]
    if (!registry) continue
    if (claim.pathTokens.length === 0 && claim.flags.length === 0) continue
    const pathFinding = resolvePath(registry, claim)
    if (pathFinding) {
      findings.push(pathFinding)
      continue // don't also report flags on an already-broken command line
    }
    findings.push(...resolveFlags(registry, claim))
  }
  return findings
}

/** Isolate the generated COMMANDS roster block and return the command names it lists. */
function rosterNames(infoText: string): Set<string> {
  const marker = '\nCOMMANDS\n'
  const start = infoText.indexOf(marker)
  if (start === -1) return new Set()
  const rest = infoText.slice(start + marker.length)
  const end = rest.indexOf('\n\n')
  const block = end === -1 ? rest : rest.slice(0, end)
  const names = new Set<string>()
  for (const line of block.split('\n')) {
    const match = line.match(/^ {2}([a-z][a-z0-9-]*)(?: {2,}|$)/)
    if (match) names.add(match[1])
  }
  return names
}

/** Completeness: every visible top-level command must appear in that CLI's rendered info roster. */
function checkRosterCompleteness(registry: Registry, infoText: string): Finding[] {
  const findings: Finding[] = []
  const listed = rosterNames(infoText)
  for (const name of registry.visibleTop) {
    if (!listed.has(name)) {
      findings.push({
        source: `${registry.bin} info COMMANDS roster`,
        line: 0,
        kind: 'undocumented-command',
        token: `${registry.bin} ${name}`,
        detail: `registered command '${name}' is missing from the generated info roster`,
      })
    }
  }
  return findings
}

// ───────────────────────── diagnostics (toolkit §3) ─────────────────────────

function fixFor(finding: Finding): string {
  switch (finding.kind) {
    case 'unknown-command':
    case 'unknown-subcommand':
      return 'FIX: the curated text references a command that is not registered — rename/remove it in the source text, or restore the handler if the removal was unintended.'
    case 'unknown-flag':
      return 'FIX: the curated text references a flag the command no longer declares — update the example, or re-add the option in the registry.'
    case 'undocumented-command':
      return 'FIX: ensure the info COMMANDS roster is generated via renderCommandRoster(program); a hand-edited roster has drifted from the registry.'
  }
}

function report(findings: Finding[]): void {
  for (const finding of findings) {
    const where = finding.line > 0 ? `${finding.source}:${finding.line}` : finding.source
    console.error(`✗ [${finding.kind}] ${where}`)
    console.error(`    token: \`${finding.token}\``)
    console.error(`    ${finding.detail}`)
    console.error(`    ${fixFor(finding)}`)
    console.error(
      '    WHY: agents read help/info as truth and misfire on commands/flags that have drifted away.'
    )
    console.error('')
  }
}

// ───────────────────────── entry ─────────────────────────

/** Run the conformance check against the live hrc + hrcchat surfaces; returns all drift findings. */
export function collectFindings(): Finding[] {
  const hrc = buildRegistry('hrc', buildHrcProgram())
  const hrcchat = buildRegistry('hrcchat', hrcchatProgram)
  const registries: Record<string, Registry> = { hrc, hrcchat }

  const hrcInfo = buildHrcInfoText(hrc.root)
  const hrcchatInfo = buildHrcchatInfoText(hrcchat.root)

  const claims: Claim[] = [
    ...extractClaims('hrc info', hrcInfo),
    ...extractClaims('hrcchat info', hrcchatInfo),
    ...extractUsageClaims('hrc usage', HRC_USAGE_TEXT),
  ]

  return [
    ...checkRosterCompleteness(hrc, hrcInfo),
    ...checkRosterCompleteness(hrcchat, hrcchatInfo),
    ...checkClaims(registries, claims),
  ]
}

// Pure helpers exported for the regression fixture (scripts/check-cli-surface.test.ts).
export {
  buildRegistry,
  extractClaims,
  extractUsageClaims,
  checkClaims,
  checkRosterCompleteness,
  type Finding,
  type Registry,
}

if (import.meta.main) {
  const findings = collectFindings()
  if (findings.length > 0) {
    console.error(`check-cli-surface: ${findings.length} help/registry conformance drift(s):\n`)
    report(findings)
    console.error('EXCEPTION: a command intentionally hidden from help should be registered with')
    console.error(
      '`{ hidden: true }` (Commander excludes it from the roster); document it in curated prose if API clients need it.'
    )
    process.exit(1)
  }
  console.log('check-cli-surface: hrc + hrcchat help/info match the live command registry ✓')
}
