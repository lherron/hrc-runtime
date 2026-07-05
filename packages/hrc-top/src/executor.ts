import type { HrcAttachDescriptor } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import type { HrcTopActionExecutor, HrcTopActionResult } from './commands.js'

type HrcTopExecutorClient = Pick<HrcClient, 'attachRuntime'>
type HrcTopSpawnOptions = {
  stdin: 'inherit'
  stdout: 'inherit'
  stderr: 'inherit' | 'pipe'
  env?: Record<string, string | undefined>
}
type HrcTopSpawnResult = {
  exited: Promise<number>
  stderr?: ReadableStream<Uint8Array> | undefined | null
}
type HrcTopSpawner = (argv: string[], options: HrcTopSpawnOptions) => HrcTopSpawnResult

export type HrcTopExecutorOptions = {
  beforeSpawn?: (() => void) | undefined
  afterSpawn?: (() => void) | undefined
  spawn?: HrcTopSpawner | undefined
}

export function createHrcTopActionExecutor(
  client: HrcTopExecutorClient,
  options: HrcTopExecutorOptions = {}
): HrcTopActionExecutor {
  const spawn: HrcTopSpawner =
    options.spawn ?? ((argv, spawnInput) => Bun.spawn({ cmd: argv, ...spawnInput }))

  return {
    async attachRuntime(runtimeId: string): Promise<HrcAttachDescriptor> {
      return client.attachRuntime({ runtimeId })
    },

    async spawnAttachDescriptor(descriptor: unknown): Promise<Partial<HrcTopActionResult>> {
      const execDescriptor = requireExecDescriptor(descriptor)
      const exitCode = await spawnAndWait(execDescriptor.argv, spawnOptions(execDescriptor.env), {
        beforeSpawn: options.beforeSpawn,
        afterSpawn: options.afterSpawn,
        spawn,
      })
      if (exitCode !== 0) {
        return {
          status: 'disabled',
          reason: `Attach exited with code ${exitCode}.`,
          detail: {
            message: `Attach exited with code ${exitCode}.`,
            argv: execDescriptor.argv,
            exitStatus: exitCode,
          },
        }
      }
      return { status: 'executed', reason: 'Attach exited; refreshed hrc top.' }
    },

    async runCommand(argv: string[]): Promise<Partial<HrcTopActionResult>> {
      const result = await spawnAndWaitWithStderr(argv, spawnOptions(undefined, 'pipe'), {
        beforeSpawn: options.beforeSpawn,
        afterSpawn: options.afterSpawn,
        spawn,
      })
      if (result.exitCode !== 0) {
        const reason = `${argv.join(' ')} exited with code ${result.exitCode}.`
        return {
          status: 'disabled',
          reason,
          detail: {
            message: reason,
            argv,
            exitStatus: result.exitCode,
            stderrSummary: result.stderrSummary,
          },
        }
      }
      return { status: 'executed', reason: `${argv.join(' ')} completed.` }
    },
  }
}

function requireExecDescriptor(descriptor: unknown): HrcAttachDescriptor {
  if (
    descriptor &&
    typeof descriptor === 'object' &&
    Array.isArray((descriptor as { argv?: unknown }).argv)
  ) {
    return descriptor as HrcAttachDescriptor
  }
  throw new Error('attach descriptor is missing argv')
}

function spawnOptions(
  env?: Record<string, string> | undefined,
  stderr: HrcTopSpawnOptions['stderr'] = 'inherit'
): HrcTopSpawnOptions {
  return {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  }
}

async function spawnAndWait(
  argv: string[],
  spawnOptionsInput: HrcTopSpawnOptions,
  options: { spawn: HrcTopSpawner } & Pick<HrcTopExecutorOptions, 'beforeSpawn' | 'afterSpawn'>
): Promise<number> {
  options.beforeSpawn?.()
  try {
    const child = options.spawn(argv, spawnOptionsInput)
    return await child.exited
  } finally {
    options.afterSpawn?.()
  }
}

async function spawnAndWaitWithStderr(
  argv: string[],
  spawnOptionsInput: HrcTopSpawnOptions,
  options: { spawn: HrcTopSpawner } & Pick<HrcTopExecutorOptions, 'beforeSpawn' | 'afterSpawn'>
): Promise<{ exitCode: number; stderrSummary?: string | undefined }> {
  options.beforeSpawn?.()
  try {
    const child = options.spawn(argv, spawnOptionsInput)
    const [exitCode, stderrSummary] = await Promise.all([
      child.exited,
      summarizeStderr(child.stderr),
    ])
    return { exitCode, stderrSummary }
  } finally {
    options.afterSpawn?.()
  }
}

async function summarizeStderr(
  stderr: ReadableStream<Uint8Array> | undefined | null
): Promise<string | undefined> {
  if (!stderr) return undefined
  const reader = stderr.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const maxBytes = 8192
  try {
    while (total < maxBytes) {
      const next = await reader.read()
      if (next.done) break
      const value = next.value
      if (!value || value.length === 0) continue
      const remaining = maxBytes - total
      const chunk = value.length > remaining ? value.slice(0, remaining) : value
      chunks.push(chunk)
      total += chunk.length
      if (value.length > remaining) break
    }
  } finally {
    reader.releaseLock()
  }

  const decoded = new TextDecoder().decode(concatChunks(chunks)).trim().replace(/\s+/g, ' ')
  if (!decoded) return undefined
  const maxChars = 1_000
  return decoded.length > maxChars ? `${decoded.slice(0, maxChars - 3)}...` : decoded
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}
