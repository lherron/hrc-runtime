import { formatDiagnosticDuration } from 'hrc-core'
import type { PhaseRecord, RunDiagnostics } from 'hrc-core'

const LABELS: Record<string, string> = {
  'resolve-scope': 'resolve scope',
  'daemon-preview': 'daemon preview',
  compile: 'compile',
  admission: 'check identity + admission',
  'inspect-prompt': 'inspect prompt placement',
  'build-preview': 'build preview',
  'create-session': 'create session',
  'prepare-run': 'prepare run',
  'save-preparation': 'save preparation',
  'broker-start': 'start broker',
  'broker-ready': 'wait for broker ready',
  attach: 'attach terminal',
  other: 'other',
}

function marker(phase: PhaseRecord): string {
  if (phase.id === 'other') return '·'
  if (phase.status === 'error') return '✗'
  if (phase.status === 'warn') return '⚠'
  if (phase.status === 'skipped' || phase.status === 'not-reached') return '–'
  return '✓'
}

function renderPhase(phase: PhaseRecord, depth: number, write: (line: string) => void): void {
  const label = LABELS[phase.id] ?? phase.id.replaceAll('-', ' ')
  const prefix = `${'  '.repeat(depth)}${marker(phase)} ${label}`
  const duration = phase.ms === undefined ? '' : `  ${formatDiagnosticDuration(phase.ms)}`
  const limit =
    phase.status === 'warn' && phase.limitMs !== undefined
      ? `  (limit ${formatDiagnosticDuration(phase.limitMs)})`
      : ''
  const reason = phase.reason === undefined ? '' : `  ${phase.reason}`
  write(`${prefix}${duration}${limit}${reason}`)
  for (const child of phase.children ?? []) renderPhase(child, depth + 1, write)
}

function formatRelease(
  label: string,
  release: { releaseId?: string | undefined; sourceCommit?: string | undefined } | undefined
): string | undefined {
  if (release === undefined) return undefined
  const parts = [release.releaseId, release.sourceCommit].filter(
    (part): part is string => typeof part === 'string'
  )
  if (parts.length === 0) return undefined
  return `${label} ${parts.join(' @ ')}`
}

const ID_LABELS: Record<string, string> = {
  requestId: 'request',
  operationId: 'operation',
  compileId: 'compile',
  runtimeId: 'runtime',
  invocationId: 'invocation',
  runId: 'run',
}

function formatDiagnosticId(key: string, value: string): string {
  const label = ID_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return `${label} ${value}`
}

function renderDiagnosticEnvelope(
  diagnostics: RunDiagnostics,
  write: (line: string) => void
): boolean {
  let rendered = false
  const releases = [
    formatRelease('hrc', diagnostics.releases.hrc),
    formatRelease('aspd', diagnostics.releases.aspd),
    formatRelease('execution', diagnostics.releases.execution),
  ].filter((release): release is string => release !== undefined)
  if (releases.length > 0) {
    write(`  ${releases.join('   ')}`)
    rendered = true
  }

  const ids = Object.entries(diagnostics.ids)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => {
      const leftIndex = Object.keys(ID_LABELS).indexOf(left)
      const rightIndex = Object.keys(ID_LABELS).indexOf(right)
      return (
        (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) -
          (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex) || left.localeCompare(right)
      )
    })
    .map(([key, value]) => formatDiagnosticId(key, value))
  if (ids.length > 0) {
    write(`  ids ${ids.join('   ')}`)
    rendered = true
  }

  const selection = diagnostics.selection
  if (selection !== undefined) {
    const fields: Array<[string, unknown, unknown]> = [
      ['harness', selection.harness, selection.provenance.harness],
      ['model provider', selection.modelProvider, selection.provenance.modelProvider],
      ['model', selection.model, selection.provenance.model],
      ['effort', selection.reasoningEffort, selection.provenance.reasoningEffort],
      ['presentation', selection.presentation, selection.provenance.presentation],
    ]
    const renderedFields = fields.filter(
      (field): field is [string, string | boolean, string] =>
        (typeof field[1] === 'string' || typeof field[1] === 'boolean') &&
        typeof field[2] === 'string'
    )
    if (renderedFields.length > 0) {
      write('Selection')
      for (const [label, value, provenance] of renderedFields) {
        write(`  ${label}  ${value}  from ${provenance}`)
      }
      rendered = true
    }
  }

  const execution = diagnostics.execution
  const executionFields = [
    execution?.driver === undefined ? undefined : `driver ${execution.driver}`,
    execution?.recipeId === undefined ? undefined : `recipe ${execution.recipeId}`,
    execution?.protocol === undefined ? undefined : `protocol ${execution.protocol}`,
  ].filter((field): field is string => field !== undefined)
  if (executionFields.length > 0) {
    write(`  ${executionFields.join('  ·  ')}`)
    rendered = true
  }

  return rendered
}

export function renderRunDiagnostics(
  diagnostics: RunDiagnostics,
  options: { write?: (line: string) => void; totalLabel?: 'total' | 'ready' } = {}
): void {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`))
  if (renderDiagnosticEnvelope(diagnostics, write)) write('')
  for (const phase of diagnostics.phases) renderPhase(phase, 1, write)
  const measured = diagnostics.phases.reduce((sum, phase) => sum + (phase.ms ?? 0), 0)
  write(`  ${options.totalLabel ?? 'total'}  ${formatDiagnosticDuration(measured)}`)
}

export function compactRunTimingFooter(diagnostics: RunDiagnostics): string {
  const flat = diagnostics.phases.flatMap((phase) => [phase, ...(phase.children ?? [])])
  const compile = flat.find((phase) => phase.id === 'compile')?.ms
  const prompt = flat.find((phase) => phase.id === 'inspect-prompt')?.ms
  const total = diagnostics.phases.reduce((sum, phase) => sum + (phase.ms ?? 0), 0)
  const details = [
    compile === undefined ? undefined : `compile ${formatDiagnosticDuration(compile)}`,
    prompt === undefined ? undefined : `prompt ${formatDiagnosticDuration(prompt)}`,
  ].filter((value): value is string => value !== undefined)
  return `ready in ${formatDiagnosticDuration(total)}${details.length > 0 ? ` (${details.join(', ')})` : ''} — -v for timeline`
}
