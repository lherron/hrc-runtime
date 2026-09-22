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

export function renderRunDiagnostics(
  diagnostics: RunDiagnostics,
  options: { write?: (line: string) => void; totalLabel?: 'total' | 'ready' } = {}
): void {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`))
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
