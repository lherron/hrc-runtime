export type PhaseStatus = 'ok' | 'warn' | 'error' | 'skipped' | 'not-reached'

export type PhaseRecord = {
  id: string
  status: PhaseStatus
  ms?: number
  limitMs?: number
  reason?: string
  children?: PhaseRecord[]
}

export type PhaseObservationSink = (record: Readonly<PhaseRecord>) => void

export type PhaseRecorder = {
  step<T>(
    id: string,
    operation: (children: PhaseRecorder) => Promise<T> | T,
    options?: { limitMs?: number }
  ): Promise<T>
  skipped(id: string, reason: string): void
  notReached(id: string, reason: string): void
  records(): PhaseRecord[]
}

type PhaseRecorderOptions = {
  now?: () => number
  sink?: PhaseObservationSink
}

function safeObserve(sink: PhaseObservationSink | undefined, record: PhaseRecord): void {
  try {
    sink?.(record)
  } catch {
    // Observation is never allowed to alter the operation being observed.
  }
}

function roundedMs(value: number): number {
  return Math.max(0, Number(value.toFixed(1)))
}

export function createPhaseRecorder(options: PhaseRecorderOptions = {}): PhaseRecorder {
  const records: PhaseRecord[] = []
  const now = options.now ?? (() => performance.now())

  const recorder: PhaseRecorder = {
    async step(id, operation, stepOptions = {}) {
      const startedAt = now()
      const childRecorder = createPhaseRecorder({
        now,
        ...(options.sink === undefined ? {} : { sink: options.sink }),
      })
      try {
        const value = await operation(childRecorder)
        const ms = roundedMs(now() - startedAt)
        const children = childRecorder.records()
        if (children.length > 0) {
          const attributedMs = children.reduce((sum, child) => sum + (child.ms ?? 0), 0)
          children.push({ id: 'other', status: 'ok', ms: roundedMs(ms - attributedMs) })
        }
        const record: PhaseRecord = {
          id,
          status: stepOptions.limitMs !== undefined && ms >= stepOptions.limitMs ? 'warn' : 'ok',
          ms,
          ...(stepOptions.limitMs === undefined ? {} : { limitMs: stepOptions.limitMs }),
          ...(children.length === 0 ? {} : { children }),
        }
        records.push(record)
        safeObserve(options.sink, record)
        return value
      } catch (error) {
        const ms = roundedMs(now() - startedAt)
        const children = childRecorder.records()
        const record: PhaseRecord = {
          id,
          status: 'error',
          ms,
          ...(stepOptions.limitMs === undefined ? {} : { limitMs: stepOptions.limitMs }),
          ...(children.length === 0 ? {} : { children }),
        }
        records.push(record)
        safeObserve(options.sink, record)
        throw error
      }
    },
    skipped(id, reason) {
      const record: PhaseRecord = { id, status: 'skipped', reason }
      records.push(record)
      safeObserve(options.sink, record)
    },
    notReached(id, reason) {
      const record: PhaseRecord = { id, status: 'not-reached', reason }
      records.push(record)
      safeObserve(options.sink, record)
    },
    records() {
      return structuredClone(records)
    },
  }
  return recorder
}

export function formatDiagnosticDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) {
    const seconds = ms / 1_000
    return `${`${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}`.replace(/\.0+$/, '')}s`
  }
  const totalSeconds = Math.round(ms / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

const SECRET_KEY_PARTS = new Set([
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'APIKEY',
  'PRIVATEKEY',
  'AUTH',
  'COOKIE',
])

export function isDiagnosticSecretKey(key: string): boolean {
  const normalized = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  if (normalized.endsWith('_FILE')) return false
  const collapsed = normalized.replaceAll('_', '')
  if (collapsed.includes('APIKEY') || collapsed.includes('PRIVATEKEY')) return true
  return normalized.split('_').some((part) => SECRET_KEY_PARTS.has(part))
}

function masked(value: string): string {
  return `•••• (${value.length} chars)`
}

const CREDENTIAL_SHAPE =
  /\b(sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|gh[po]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[abpr]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g

export function maskDiagnosticString(value: string): string {
  return value
    .replace(CREDENTIAL_SHAPE, (credential) => masked(credential))
    .replace(
      /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|auth|cookie)[A-Za-z0-9_-]*)=([^\s="'`\\&]+)/gi,
      (match, key: string, raw: string) =>
        isDiagnosticSecretKey(key) ? `${key}=${masked(raw)}` : match
    )
}

export function maskDiagnosticEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      isDiagnosticSecretKey(key) ? masked(value) : maskDiagnosticString(value),
    ])
  )
}

function flagKey(value: string): string {
  return value.replace(/^-+/, '').split('=', 1)[0] ?? ''
}

export function maskDiagnosticArgv(argv: readonly string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? ''
    const equals = value.indexOf('=')
    if (value.startsWith('-') && equals > 0 && isDiagnosticSecretKey(flagKey(value))) {
      const raw = value.slice(equals + 1)
      result.push(`${value.slice(0, equals + 1)}${masked(raw)}`)
      continue
    }
    result.push(maskDiagnosticString(value))
    if (value.startsWith('-') && isDiagnosticSecretKey(flagKey(value)) && index + 1 < argv.length) {
      const raw = argv[index + 1] ?? ''
      result.push(masked(raw))
      index += 1
    }
  }
  return result
}
