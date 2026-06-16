import { spawn } from 'node:child_process'

import { printJson } from '../print.js'
import { resolveRuntimeArg, resolveSessionArg } from '../selector-resolve.js'
import {
  hasFlag,
  parseExpectedGeneration,
  parseFlag,
  parseProviderFlag,
  requireArg,
} from './argv.js'
import { printHrcDomainErrorBody } from './errors.js'
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

export async function execHrcchatTurn(forwarded: string[]): Promise<never> {
  const child = spawn('hrcchat', ['turn', ...forwarded], { stdio: 'inherit' })
  return await new Promise<never>((_resolve, reject) => {
    child.on('error', (err) => {
      reject(err)
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal as NodeJS.Signals)
        return
      }
      process.exit(code ?? 0)
    })
  })
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
    if (printHrcDomainErrorBody(err)) {
      return
    }
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
    if (printHrcDomainErrorBody(err)) {
      return
    }
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

export async function cmdBridgeRegister(args: string[]): Promise<void> {
  const hostSessionArg = requireArg(args, 0, '<hostSessionId>')
  const transport = parseFlag(args, '--transport')
  const target = parseFlag(args, '--target')
  const runtimeId = parseFlag(args, '--runtime-id')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')

  if (!transport) {
    fatal('--transport is required for bridge register')
  }
  if (!target) {
    fatal('--target is required for bridge register')
  }

  const expectedGeneration = parseExpectedGeneration(args)

  const client = createClient()
  const hostSessionId = await resolveSessionArg(hostSessionArg, client)
  const result = await client.registerBridgeTarget({
    hostSessionId,
    ...(runtimeId ? { runtimeId } : {}),
    transport,
    target,
    ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  })
  printJson(result)
}

export async function cmdBridgeDeliver(args: string[]): Promise<void> {
  const bridgeId = requireArg(args, 0, '<bridgeId>')
  const text = parseFlag(args, '--text')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')

  if (!text) {
    fatal('--text is required for bridge deliver')
  }

  const expectedGeneration = parseExpectedGeneration(args)

  const client = createClient()
  const result = await client.deliverBridge({
    bridgeId,
    text,
    ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  })
  printJson(result)
}

export async function cmdBridgeList(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const result = await client.listBridges({ runtimeId })
  printJson(result)
}

export async function cmdBridgeClose(args: string[]): Promise<void> {
  const bridgeId = requireArg(args, 0, '<bridgeId>')
  const client = createClient()
  const result = await client.closeBridge({ bridgeId })
  printJson(result)
}

export async function cmdBridgeTarget(args: string[]): Promise<void> {
  const bridge = parseFlag(args, '--bridge')
  const hostSession = parseFlag(args, '--host-session')
  const sessionRef = parseFlag(args, '--session-ref')
  const transport = parseFlag(args, '--transport')
  const target = parseFlag(args, '--target')
  const runtimeId = parseFlag(args, '--runtime-id')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')

  // --bridge is a convenience alias for --transport tmux --target <value>
  const effectiveTransport = transport ?? (bridge ? 'tmux' : undefined)
  const effectiveTarget = target ?? bridge

  if (!effectiveTransport) {
    fatal('--transport (or --bridge) is required for bridge target')
  }
  if (!effectiveTarget) {
    fatal('--target (or --bridge) is required for bridge target')
  }

  // Selector: exactly one of --host-session or --session-ref
  if (!hostSession && !sessionRef) {
    fatal('bridge target requires --host-session or --session-ref selector')
  }
  if (hostSession && sessionRef) {
    fatal('bridge target accepts --host-session or --session-ref, not both')
  }

  const expectedGeneration = parseExpectedGeneration(args)

  const selector: import('hrc-core').HrcBridgeTargetSelector = sessionRef
    ? { sessionRef }
    : { hostSessionId: hostSession as string }

  const client = createClient()
  const result = await client.acquireBridgeTarget({
    selector,
    transport: effectiveTransport,
    target: effectiveTarget,
    ...(runtimeId ? { runtimeId } : {}),
    ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  })
  printJson(result)
}

export async function cmdBridgeDeliverText(args: string[]): Promise<void> {
  const bridge = parseFlag(args, '--bridge')
  const text = parseFlag(args, '--text')
  const enter = hasFlag(args, '--enter')
  const oobSuffix = parseFlag(args, '--oob-suffix')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')

  if (!bridge) {
    fatal('--bridge is required for bridge deliver-text')
  }
  if (!text) {
    fatal('--text is required for bridge deliver-text')
  }

  const expectedGeneration = parseExpectedGeneration(args)

  const client = createClient()
  const result = await client.deliverBridgeText({
    bridgeId: bridge,
    text,
    enter,
    ...(oobSuffix ? { oobSuffix } : {}),
    ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  })
  printJson(result)
}
