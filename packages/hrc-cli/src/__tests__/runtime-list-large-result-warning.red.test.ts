import { describe, expect, it } from 'bun:test'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { cmdRuntimeList } from '../cli/handlers-runtime.js'

type CapturedOutput = {
  stdout: string
  stderr: string
}

function runtimeFixtures(count: number): HrcRuntimeSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    runtimeId: `rt-${index}`,
    hostSessionId: `session-${index}`,
    scopeRef: `agent:test:project:hrc-runtime:task:T-${index}`,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'terminated',
    supportsInflightInput: false,
    adopted: false,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    statusChangedAt: 'unknown',
  }))
}

function captureChunk(chunk: string | ArrayBufferView | ArrayBuffer, chunks: string[]): void {
  if (typeof chunk === 'string') {
    chunks.push(chunk)
    return
  }
  chunks.push(Buffer.from(chunk as ArrayBufferView).toString('utf8'))
}

async function runRuntimeList(runtimes: HrcRuntimeSnapshot[]): Promise<CapturedOutput> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const originalListRuntimes = HrcClient.prototype.listRuntimes
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write

  HrcClient.prototype.listRuntimes = (async () => runtimes) as HrcClient['listRuntimes']
  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
    captureChunk(chunk, stdoutChunks)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
    captureChunk(chunk, stderrChunks)
    return true
  }) as typeof process.stderr.write

  try {
    await cmdRuntimeList(['--json'])
    return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') }
  } finally {
    HrcClient.prototype.listRuntimes = originalListRuntimes
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
}

describe('hrc runtime list large-result warning', () => {
  it('warns on stderr above 100 runtimes without changing stdout', async () => {
    const runtimes = runtimeFixtures(101)
    const expectedStdout = `${JSON.stringify(runtimes, null, 2)}\n`

    const result = await runRuntimeList(runtimes)

    expect(result.stdout).toBe(expectedStdout)
    expect(result.stderr).toBe(
      `hrc: runtime list returned 101 runtimes (${Buffer.byteLength(expectedStdout)} bytes) — narrow with --task/--scope/--agent/--status/--transport/--session\n`
    )
  })

  it('does not warn at 100 runtimes and leaves stdout unchanged', async () => {
    const runtimes = runtimeFixtures(100)
    const expectedStdout = `${JSON.stringify(runtimes, null, 2)}\n`

    const result = await runRuntimeList(runtimes)

    expect(result.stdout).toBe(expectedStdout)
    expect(result.stderr).toBe('')
  })
})
