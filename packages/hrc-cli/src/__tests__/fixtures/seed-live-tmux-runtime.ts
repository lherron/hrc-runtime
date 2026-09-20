/**
 * T-08596 (T-08569A closure) — seed a LIVE legacy-tmux runtime row backed by a
 * real tmux pane for CLI plumbing tests (capture/attach/interrupt/terminate/
 * surface-bind/list). Birthing through `admin runtime ensure` is gone on nodes
 * that declare no aspd endpoint (typed `aspd_unconfigured` refusal), so tests
 * that exercise runtime ACTIONS rather than births seed the row directly.
 */
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

export type SeededLiveTmuxRuntime = {
  hostSessionId: string
  runtimeId: string
  socketPath: string
  cleanup: () => Promise<void>
}

async function tmuxCapture(socketPath: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['tmux', '-S', socketPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed (${code}): ${err.trim()}`)
  }
  return out.trim()
}

export async function seedLiveTmuxRuntime(
  dbPath: string,
  hostSessionId: string
): Promise<SeededLiveTmuxRuntime> {
  const tag = randomUUID().slice(0, 8)
  const socketPath = join(tmpdir(), `hrc-cli-seed-${tag}.sock`)
  const sessionName = `seed-${tag}`
  const runtimeId = `rt-seed-${tag}`
  await tmuxCapture(socketPath, [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-n',
    'main',
    '-x',
    '200',
    '-y',
    '50',
    'sleep',
    '120',
  ])
  const [sessionId, windowId, paneId] = (
    await tmuxCapture(socketPath, [
      'display-message',
      '-p',
      '-t',
      sessionName,
      '#{session_id} #{window_id} #{pane_id}',
    ])
  ).split(' ')
  if (!sessionId || !windowId || !paneId) {
    throw new Error(`tmux display-message returned no pane ids for ${sessionName}`)
  }

  const now = new Date().toISOString()
  const launchId = `launch-seed-${tag}`
  const db = openHrcDatabase(dbPath)
  try {
    const session = db.sessions.getByHostSessionId(hostSessionId)
    if (session === null) throw new Error(`no session row for ${hostSessionId}`)
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      tmuxJson: {
        sessionName,
        sessionId,
        windowId,
        paneId,
        socketPath,
        brokerDriver: 'claude-code-tmux',
        windowName: 'main',
      },
      createdAt: now,
      updatedAt: now,
    })
    db.launches.insert({
      launchId,
      hostSessionId,
      runtimeId,
      generation: session.generation,
      harness: 'claude-code',
      provider: 'anthropic',
      launchArtifactPath: join(tmpdir(), `hrc-cli-seed-${tag}.artifact.json`),
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  return {
    hostSessionId,
    runtimeId,
    socketPath,
    cleanup: async () => {
      const proc = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await proc.exited.catch(() => undefined)
    },
  }
}
