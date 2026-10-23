import { printJson } from '../print.js'
import { resolveRuntimeArg, resolveSessionArg } from '../selector-resolve.js'
import { hasFlag, parseFlag, parseProviderFlag, requireArg } from './argv.js'
import { throwIfHrcDomainError } from './errors.js'
import { createDefaultRuntimeIntent } from './scope.js'
import { createClient, fatal } from './shared.js'

export async function cmdRuntimeEnsure(args: string[]): Promise<void> {
  const hostSessionArg = requireArg(args, 0, '<hostSessionId>')
  const providerRaw = parseProviderFlag(args)
  const restartStyleRaw = parseFlag(args, '--restart-style')

  if (
    restartStyleRaw !== undefined &&
    restartStyleRaw !== 'reuse_pty' &&
    restartStyleRaw !== 'fresh_pty'
  ) {
    fatal('--restart-style must be one of: reuse_pty, fresh_pty')
  }
  const restartStyle =
    restartStyleRaw === 'reuse_pty' || restartStyleRaw === 'fresh_pty' ? restartStyleRaw : undefined

  const client = createClient()
  const hostSessionId = await resolveSessionArg(hostSessionArg, client)
  const result = await client.ensureRuntime({
    hostSessionId,
    intent: createDefaultRuntimeIntent(providerRaw),
    ...(restartStyle ? { restartStyle } : {}),
  })
  printJson(result)
}

export async function cmdInflightSend(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const runId = parseFlag(args, '--run-id')
  const input = parseFlag(args, '--input')
  const inputType = parseFlag(args, '--input-type')

  if (!runId) {
    fatal('--run-id is required for inflight send')
  }

  if (!input) {
    fatal('--input is required for inflight send')
  }

  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const result = await client.sendInFlightInput({
    runtimeId,
    runId,
    prompt: input,
    ...(inputType ? { inputType } : {}),
  })
  printJson(result)
}

export async function cmdSessionClearContext(args: string[]): Promise<void> {
  const hostSessionArg = requireArg(args, 0, '<hostSessionId>')
  const relaunch = hasFlag(args, '--relaunch')

  const client = createClient()
  const hostSessionId = await resolveSessionArg(hostSessionArg, client)
  const result = await client.clearContext({
    hostSessionId,
    ...(relaunch ? { relaunch: true } : {}),
  })
  printJson(result)
}

export async function cmdCapture(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  try {
    const runtimeId = await resolveRuntimeArg(runtimeArg, client)
    const result = await client.capture(runtimeId)
    process.stdout.write(result.text)
    if (!result.text.endsWith('\n')) {
      process.stdout.write('\n')
    }
  } catch (err) {
    throwIfHrcDomainError(err)
    throw err
  }
}

export async function cmdInterrupt(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  try {
    const runtimeId = await resolveRuntimeArg(runtimeArg, client)
    const result = await client.interrupt(runtimeId)
    printJson(result)
  } catch (err) {
    throwIfHrcDomainError(err)
    throw err
  }
}

export async function cmdTerminate(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const dropContinuation = hasFlag(args, '--drop-continuation')
  const noDropContinuation = hasFlag(args, '--no-drop-continuation')
  if (dropContinuation && noDropContinuation) {
    fatal('--drop-continuation and --no-drop-continuation are mutually exclusive')
  }
  const reason = parseFlag(args, '--reason')
  const source = parseFlag(args, '--source')

  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const result = await client.terminate(runtimeId, {
    ...(dropContinuation ? { dropContinuation: true } : {}),
    ...(noDropContinuation ? { dropContinuation: false } : {}),
    ...(reason ? { reason } : {}),
    ...(source ? { source } : {}),
  })
  printJson(result)
}

export async function cmdSurfaceBind(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const surfaceKind = parseFlag(args, '--kind')
  const surfaceId = parseFlag(args, '--id')

  if (!surfaceKind) {
    fatal('--kind is required for surface bind')
  }
  if (!surfaceId) {
    fatal('--id is required for surface bind')
  }

  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const descriptor = await client.getAttachDescriptor(runtimeId)
  const result = await client.bindSurface({
    surfaceKind,
    ...descriptor.bindingFence,
    surfaceId,
  })
  printJson(result)
}

export async function cmdSurfaceUnbind(args: string[]): Promise<void> {
  const surfaceKind = parseFlag(args, '--kind')
  const surfaceId = parseFlag(args, '--id')
  const reason = parseFlag(args, '--reason')

  if (!surfaceKind) {
    fatal('--kind is required for surface unbind')
  }
  if (!surfaceId) {
    fatal('--id is required for surface unbind')
  }

  const client = createClient()
  const result = await client.unbindSurface({
    surfaceKind,
    surfaceId,
    ...(reason ? { reason } : {}),
  })
  printJson(result)
}

export async function cmdSurfaceList(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const result = await client.listSurfaces({ runtimeId })
  printJson(result)
}
