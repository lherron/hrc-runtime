// --- Timing instrumentation (T-07388) -------------------------------------
//
// Every subprocess in this script funnels through run()/tryRun(), so wrapping
// those two is sufficient to account for all spawn cost. The ledger groups by
// command + subcommand ("ghostmux metadata get") rather than by full argv, so
// an O(N) fan-out shows up as one row with a high `count` — which is the defect
// class this instrumentation exists to make visible.

export type SpawnStat = {
  key: string
  count: number
  totalMs: number
  samples: number[]
}

export type PhaseStat = {
  name: string
  ms: number
}

export const spawnStats = new Map<string, SpawnStat>()
export const phaseStats: PhaseStat[] = []

// Collapse an argv into a stable bucket key: the command basename plus any
// leading non-flag, non-path tokens (the subcommand path). `sqlite3 -tabs
// -noheader /path/db <sql>` therefore buckets as plain "sqlite3", while
// `ghostmux metadata get -t ...` buckets as "ghostmux metadata get".
export function spawnKey(argv: string[]): string {
  const command = (argv[0] ?? '').split('/').pop() ?? ''
  const parts = [command]
  for (const token of argv.slice(1)) {
    if (token.startsWith('-') || token.includes('/') || token.includes('\n')) break
    parts.push(token)
    if (parts.length === 3) break
  }
  return parts.join(' ')
}

export function recordSpawn(argv: string[], ms: number): void {
  const key = spawnKey(argv)
  const stat = spawnStats.get(key) ?? { key, count: 0, totalMs: 0, samples: [] }
  stat.count += 1
  stat.totalMs += ms
  stat.samples.push(ms)
  spawnStats.set(key, stat)
}

// Nearest-rank quantile over an already-sorted ascending array.
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil(q * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0
}

export function timePhase<T>(name: string, fn: () => T): T {
  const started = performance.now()
  try {
    return fn()
  } finally {
    phaseStats.push({ name, ms: performance.now() - started })
  }
}

export async function timePhaseAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await fn()
  } finally {
    phaseStats.push({ name, ms: performance.now() - started })
  }
}

export function run(argv: string[], input?: string): string {
  const started = performance.now()
  const proc = Bun.spawnSync(argv, {
    stdin: input ? new TextEncoder().encode(input) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  recordSpawn(argv, performance.now() - started)
  const stdout = new TextDecoder().decode(proc.stdout)
  const stderr = new TextDecoder().decode(proc.stderr)
  if (proc.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed (${proc.exitCode}): ${stderr || stdout}`)
  }
  return stdout
}

export function tryRun(argv: string[]): string {
  try {
    return run(argv)
  } catch {
    return ''
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireCommand(command: string): void {
  const argv = ['bash', '-lc', `command -v ${command}`]
  const started = performance.now()
  const proc = Bun.spawnSync(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  recordSpawn(argv, performance.now() - started)
  if (proc.exitCode !== 0) throw new Error(`missing required command: ${command}`)
}
