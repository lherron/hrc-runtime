import type { HrcAttachDescriptor } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import type { HrcTopActionExecutor, HrcTopActionResult } from './commands.js'

type HrcTopExecutorClient = Pick<HrcClient, 'attachRuntime'>
type HrcTopSpawnOptions = {
  stdin: 'inherit'
  stdout: 'inherit'
  stderr: 'inherit'
  env?: Record<string, string | undefined>
}
type HrcTopSpawner = (argv: string[], options: HrcTopSpawnOptions) => { exited: Promise<number> }

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
        return { status: 'disabled', reason: `Attach exited with code ${exitCode}.` }
      }
      return { status: 'executed', reason: 'Attach exited; refreshed hrc top.' }
    },

    async runCommand(argv: string[]): Promise<Partial<HrcTopActionResult>> {
      const exitCode = await spawnAndWait(argv, spawnOptions(), {
        beforeSpawn: options.beforeSpawn,
        afterSpawn: options.afterSpawn,
        spawn,
      })
      if (exitCode !== 0) {
        return { status: 'disabled', reason: `${argv.join(' ')} exited with code ${exitCode}.` }
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

function spawnOptions(env?: Record<string, string> | undefined): HrcTopSpawnOptions {
  return {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
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
