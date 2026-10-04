/**
 * The one declaration of each scope verb's options (`hrc start`, `run`, `resume`).
 *
 * A scope verb used to name each flag five times: the commander declaration,
 * `assertNoUnknownOptions`'s boolean/value lists, the `toLegacyArgv` schema, the
 * handler's `parseScopePrompt` passthrough list, and a global set of the
 * value-taking ones. Each copy that missed a new flag failed differently and
 * only on the installed binary: undeclared on commander, so "unknown option"
 * (28211686); missing from the value-taking set, so its value became the prompt
 * (68508938). Every list is now derived from these Option factories, so adding a
 * flag here is the whole change. Factories, not shared instances, because each
 * program build owns its Option objects.
 */
import { Option } from 'commander'

import type { LegacyArgvSchema } from './argv.js'

/** Prompt sources that `parseScopePrompt` reads itself rather than passing through. */
const PROMPT_SOURCE_FLAGS = new Set(['-p', '--prompt-file'])

const promptOptions = (): Option[] => [
  new Option('-p <text>', 'initial prompt to send to the harness'),
  new Option('--prompt-file <path>', 'read initial prompt from a file'),
]

const projectOptions = (): Option[] => [
  new Option('--project-id <id>', 'override the inferred project id'),
  new Option('--project-root <path>', 'override project root'),
]

const cwdOption = (): Option =>
  new Option('--cwd <path>', 'set execution cwd without changing the resolved project root')

const rotationOptions = (): Option[] => [
  new Option('--force-restart', 'replace runtime with a fresh PTY; preserve the conversation'),
  new Option('--new-session', 'rotate to a fresh host session before starting'),
]

const debugOption = (): Option => new Option('--debug', 'keep tmux shell alive after harness exits')
const noRegisterOption = (): Option =>
  new Option('--no-register', 'do not prompt to register cwd as a project marker')
const jsonOption = (): Option =>
  new Option('--json', 'on error, emit structured JSON (includes broker rejection detail)')

export function startOptions(): Option[] {
  return [
    ...rotationOptions(),
    new Option('--dry-run', 'daemon plan preview — no side effects'),
    debugOption(),
    noRegisterOption(),
    jsonOption(),
    ...projectOptions(),
    cwdOption(),
    new Option('--idempotency-key <key>', 'stable retry identity for the prompt dispatch'),
    new Option('--viewer-window <key>', 'place this session viewer tab in the keyed window'),
    new Option(
      '--no-viewer',
      'run headless with no operator viewer or terminal (codex: prepares through aspd when configured); refused if the scope already has a live viewer or TUI'
    ),
    new Option(
      '--app-server-viewer',
      'run codex on the headless app-server with the attachable tmux renderer viewer (prepares through aspd when configured); refused if the scope already has a live runtime without that viewer'
    ),
    new Option(
      '--on-conflict <policy>',
      'suffix: claim the next free roster slot instead of hijacking a live :primary; reject: claim exactly this scope or refuse'
    ).choices(['suffix', 'reject']),
    ...promptOptions(),
    new Option('--wait [mode]', 'wait for the prompt turn to start or become terminal')
      .choices(['started', 'completed'])
      .preset('completed'),
  ]
}

export function runOptions(): Option[] {
  return [
    ...rotationOptions(),
    new Option(
      '--attach-only',
      'reattach to the existing runtime without starting one (like `hrc attach`)'
    ),
    new Option('--dry-run', 'daemon plan preview — no side effects'),
    new Option('-v, --verbose', 'show the full run phase timeline on stderr'),
    debugOption(),
    noRegisterOption(),
    jsonOption(),
    ...projectOptions(),
    ...promptOptions(),
  ]
}

export function resumeOptions(): Option[] {
  return [
    new Option('--no-attach', 'resume and start without attaching to the tmux session'),
    new Option('--prior', "resume the current session's immediate predecessor"),
    new Option('--host-session <id>', 'resume an exact historical host session'),
    new Option('--dry-run', 'local plan preview — no side effects'),
    debugOption(),
    noRegisterOption(),
    jsonOption(),
    ...projectOptions(),
    cwdOption(),
    ...promptOptions(),
  ]
}

function optionFlags(option: Option): string[] {
  return [option.short, option.long].filter((flag): flag is string => flag !== undefined)
}

/** `assertNoUnknownOptions` schema for a verb's raw argv. */
export function unknownOptionSchema(options: readonly Option[]): {
  boolean: string[]
  value: string[]
  optionalValue: string[]
} {
  return {
    boolean: options.filter((o) => !o.required && !o.optional).flatMap(optionFlags),
    value: options.filter((o) => o.required).flatMap(optionFlags),
    optionalValue: options.filter((o) => o.optional).flatMap(optionFlags),
  }
}

/**
 * `toLegacyArgvForScopeCommand` schema. `-p` has no long form and is emitted by
 * that function itself; negated options are named by their positive attribute.
 */
export function legacyArgvSchema(options: readonly Option[]): LegacyArgvSchema {
  const named = options.filter((o) => o.long !== undefined)
  const longName = (o: Option) => (o.long as string).slice(2)
  return {
    strings: named.filter((o) => o.required || o.optional).map(longName),
    booleans: named.filter((o) => !o.required && !o.optional && !o.negate).map(longName),
    negatedBooleans: named.filter((o) => o.negate).map((o) => longName(o).slice('no-'.length)),
  }
}

/**
 * Flags `parseScopePrompt` steps over, mapped to whether the legacy argv
 * carries a value after them. An optional-value flag always carries one there:
 * `toLegacyArgv` emits commander's preset.
 */
export function passthroughFlagArity(options: readonly Option[]): ReadonlyMap<string, boolean> {
  const arity = new Map<string, boolean>()
  for (const option of options) {
    for (const flag of optionFlags(option)) {
      if (PROMPT_SOURCE_FLAGS.has(flag)) continue
      arity.set(flag, option.required || option.optional)
    }
  }
  return arity
}
