import { openHrcDatabase } from 'hrc-store-sqlite'

export function seedSessionContinuation(dbPath: string, hostSessionId: string, key: string): void {
  const db = openHrcDatabase(dbPath)
  try {
    db.sessions.updateContinuation(
      hostSessionId,
      { provider: 'anthropic', key },
      new Date().toISOString()
    )
  } finally {
    db.close()
  }
}

export function seedTerminatedTmuxRuntime(
  dbPath: string,
  input: { hostSessionId: string; scopeRef: string; runtimeId: string }
): void {
  const db = openHrcDatabase(dbPath)
  const now = new Date().toISOString()
  try {
    db.runtimes.insert({
      runtimeId: input.runtimeId,
      hostSessionId: input.hostSessionId,
      scopeRef: input.scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'terminated',
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

export function readRuntime(dbPath: string, runtimeId: string) {
  const db = openHrcDatabase(dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId) ?? null
  } finally {
    db.close()
  }
}

export async function waitForRuntimeStatus(
  dbPath: string,
  runtimeId: string,
  expectedStatuses: string[],
  timeoutMs = 5_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const db = openHrcDatabase(dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      if (runtime && expectedStatuses.includes(runtime.status)) return runtime.status
    } finally {
      db.close()
    }
    await Bun.sleep(100)
  }
  throw new Error(
    `runtime ${runtimeId} did not reach one of [${expectedStatuses.join(', ')}] within ${timeoutMs}ms`
  )
}

export async function waitForQueuedPrompt(
  dbPath: string,
  hostSessionId: string,
  prompt: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const db = openHrcDatabase(dbPath)
    try {
      const found = db.runs.listQueuedByHostSessionId(hostSessionId).some((run) => {
        const correlation = db.runs.getCorrelationJson(run.runId)
        return correlation !== null && JSON.parse(correlation).prompt === prompt
      })
      if (found) return
    } finally {
      db.close()
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for queued prompt ${JSON.stringify(prompt)}`)
}
