#!/usr/bin/env bun
import {
  resolveControlSocketPath,
  resolveDatabasePath,
  resolveRuntimeRoot,
  resolveSpoolDir,
  resolveStateRoot,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'

// -- Helpers ------------------------------------------------------------------

function fatal(message: string): never {
  process.stderr.write(`hrc: ${message}\n`)
  process.exit(1)
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function requireArg(args: string[], index: number, name: string): string {
  const value = args[index]
  if (value === undefined || value.startsWith('-')) {
    fatal(`missing required argument: ${name}`)
  }
  return value
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  if (value === undefined || value.startsWith('-')) {
    fatal(`${flag} requires a value`)
  }
  return value
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function createClient(): HrcClient {
  const socketPath = discoverSocket()
  return new HrcClient(socketPath)
}

// -- Stub commands ------------------------------------------------------------

const STUB_COMMANDS = new Set(['capture', 'attach', 'clear-context', 'interrupt', 'terminate'])

function runStub(command: string): never {
  process.stderr.write(`hrc ${command}: not implemented yet\n`)
  process.exit(1)
}

// -- Command handlers ---------------------------------------------------------

async function cmdServer(): Promise<void> {
  const { createHrcServer } = await import('hrc-server')

  const runtimeRoot = resolveRuntimeRoot()
  const stateRoot = resolveStateRoot()

  const server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath: resolveControlSocketPath(),
    lockPath: `${runtimeRoot}/server.lock`,
    spoolDir: resolveSpoolDir(),
    dbPath: resolveDatabasePath(),
  })

  process.stderr.write(`hrc: server listening on ${resolveControlSocketPath()}\n`)

  const shutdown = async () => {
    process.stderr.write('hrc: shutting down...\n')
    await server.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function cmdSessionResolve(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  if (!scope) fatal('--scope is required for session resolve')

  const lane = parseFlag(args, '--lane') ?? 'default'
  const sessionRef = `${scope}/lane:${lane}`

  const client = createClient()
  const result = await client.resolveSession({ sessionRef })
  printJson(result)
}

async function cmdSessionList(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  const lane = parseFlag(args, '--lane')

  const client = createClient()
  const sessions = await client.listSessions({
    ...(scope ? { scopeRef: scope } : {}),
    ...(lane ? { laneRef: lane } : {}),
  })
  printJson(sessions)
}

async function cmdSessionGet(args: string[]): Promise<void> {
  const hostSessionId = requireArg(args, 0, '<hostSessionId>')

  const client = createClient()
  const session = await client.getSession(hostSessionId)
  printJson(session)
}

async function cmdSession(args: string[]): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)

  switch (subcommand) {
    case 'resolve':
      return cmdSessionResolve(rest)
    case 'list':
      return cmdSessionList(rest)
    case 'get':
      return cmdSessionGet(rest)
    default:
      fatal(
        subcommand
          ? `unknown session subcommand: ${subcommand}`
          : 'session subcommand required (resolve, list, get)'
      )
  }
}

async function cmdWatch(args: string[]): Promise<void> {
  const fromSeqRaw = parseFlag(args, '--from-seq')
  const follow = hasFlag(args, '--follow')

  const fromSeq = fromSeqRaw !== undefined ? Number.parseInt(fromSeqRaw, 10) : undefined
  if (fromSeqRaw !== undefined && (!Number.isFinite(fromSeq) || (fromSeq ?? 0) < 1)) {
    fatal('--from-seq must be a positive integer')
  }

  const client = createClient()
  for await (const event of client.watch({ fromSeq, follow })) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }
}

async function cmdRuntimeEnsure(): Promise<never> {
  process.stderr.write('hrc runtime ensure: not implemented yet\n')
  process.exit(1)
}

async function cmdRuntime(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'ensure':
      return cmdRuntimeEnsure()
    default:
      fatal(
        subcommand
          ? `unknown runtime subcommand: ${subcommand}`
          : 'runtime subcommand required (ensure)'
      )
  }
}

async function cmdTurnSend(): Promise<never> {
  process.stderr.write('hrc turn send: not implemented yet\n')
  process.exit(1)
}

async function cmdTurn(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'send':
      return cmdTurnSend()
    default:
      fatal(
        subcommand ? `unknown turn subcommand: ${subcommand}` : 'turn subcommand required (send)'
      )
  }
}

// -- Usage --------------------------------------------------------------------

function printUsage(): void {
  process.stderr.write(`hrc — HRC operator CLI

Usage: hrc <command> [options]

Commands:
  server                              Start the HRC daemon
  session resolve --scope <ref> [--lane <ref>]  Resolve or create a session
  session list [--scope <ref>] [--lane <ref>]   List sessions
  session get <hostSessionId>         Get a session by host session ID
  watch [--from-seq <n>] [--follow]   Watch HRC event stream (NDJSON)
  runtime ensure                      (not implemented)
  turn send                           (not implemented)
  capture <hostSessionId>             (not implemented)
  attach <hostSessionId>              (not implemented)
  clear-context <hostSessionId>       (not implemented)
  interrupt <hostSessionId>           (not implemented)
  terminate <hostSessionId>           (not implemented)
`)
}

// -- Main dispatch ------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const rest = args.slice(1)

  if (!command || command === '--help' || command === '-h') {
    printUsage()
    if (!command) process.exit(1)
    return
  }

  try {
    switch (command) {
      case 'server':
        return await cmdServer()
      case 'session':
        return await cmdSession(rest)
      case 'watch':
        return await cmdWatch(rest)
      case 'runtime':
        return await cmdRuntime(rest)
      case 'turn':
        return await cmdTurn(rest)
      default:
        if (STUB_COMMANDS.has(command)) {
          runStub(command)
        }
        fatal(`unknown command: ${command}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fatal(message)
  }
}

main()
