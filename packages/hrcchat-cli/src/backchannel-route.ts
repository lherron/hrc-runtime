import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { CliUsageError } from 'cli-kit'
import type { HrcMessageAddress, SemanticDmResponse } from 'hrc-core'

type RouteProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type RouteGate = {
  scriptPath: string
  env: Record<string, string | undefined>
}

export async function tryRouteBackchannelDm(args: {
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
}): Promise<SemanticDmResponse | undefined> {
  if (args.to.kind !== 'session') return undefined
  const gate = resolveRouteGate()
  if (!gate) return undefined

  const route = await resolveRemoteRoute(gate, args.to.sessionRef)
  if (!route) return undefined

  const fromValue = args.from.kind === 'session' ? args.from.sessionRef : args.from.entity
  const result = await runRouteProcess(
    gate,
    ['send', args.to.sessionRef, args.from.kind, fromValue],
    args.body
  )
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `bridge exited ${result.exitCode}`
    throw new Error(
      `backchannel route=${route} target=${args.to.sessionRef} failed: ${detail}; refusing local fallback`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(
      `backchannel route=${route} target=${args.to.sessionRef} returned invalid JSON; refusing local fallback`
    )
  }
  if (!isSemanticDmResponse(parsed)) {
    throw new Error(
      `backchannel route=${route} target=${args.to.sessionRef} returned no durable message receipt; refusing local fallback`
    )
  }
  return parsed
}

export async function assertBackchannelFollowAllowed(sessionRef: string): Promise<void> {
  const gate = resolveRouteGate()
  if (!gate) return
  const route = await resolveRemoteRoute(gate, sessionRef)
  if (!route) return
  throw new CliUsageError(
    `dm --follow is not supported for interim backchannel route ${route} (${sessionRef}); send a plain dm instead`
  )
}

function resolveRouteGate(): RouteGate | undefined {
  if (process.env['BACKCHANNEL_BYPASS'] === '1') return undefined

  const backchannelDir =
    process.env['BACKCHANNEL_DIR'] ?? join(process.env['HOME'] ?? '', 'praesidium/var/backchannel')
  const routesPath = process.env['BACKCHANNEL_ROUTES'] ?? join(backchannelDir, 'routes.tsv')
  const scriptPath =
    process.env['BACKCHANNEL_SCRIPT'] ?? join(backchannelDir, 'interim-dm-backchannel.sh')
  const nodePath = process.env['BACKCHANNEL_NODE_FILE'] ?? join(backchannelDir, 'node')

  // Interim behavior is explicitly opt-in. Removing the route table at
  // demotion restores the original hrcchat path without another code change.
  if (!existsSync(routesPath) || !existsSync(scriptPath)) return undefined
  if (process.env['BACKCHANNEL_NODE'] === undefined && !existsSync(nodePath)) return undefined

  return { scriptPath, env: { ...process.env, BACKCHANNEL_ROUTES: routesPath } }
}

async function resolveRemoteRoute(
  gate: RouteGate,
  sessionRef: string
): Promise<string | undefined> {
  const result = await runRouteProcess(gate, ['route', sessionRef])
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `bridge exited ${result.exitCode}`
    throw new Error(`backchannel route lookup failed for target=${sessionRef}: ${detail}`)
  }
  return result.stdout.trim() || undefined
}

async function runRouteProcess(
  gate: RouteGate,
  args: string[],
  stdin?: string
): Promise<RouteProcessResult> {
  const proc = Bun.spawn({
    cmd: [gate.scriptPath, ...args],
    env: gate.env,
    stdin: stdin === undefined ? undefined : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

function isSemanticDmResponse(value: unknown): value is SemanticDmResponse {
  if (typeof value !== 'object' || value === null) return false
  const request = Reflect.get(value, 'request')
  if (typeof request !== 'object' || request === null) return false
  return typeof Reflect.get(request, 'messageId') === 'string'
}
