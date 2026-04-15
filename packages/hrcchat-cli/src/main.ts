#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HrcDomainError } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'

import { fatal } from './cli-args.js'
import { cmdDm } from './commands/dm.js'
import { cmdDoctor } from './commands/doctor.js'
import { cmdMessages } from './commands/messages.js'
import { cmdPeek } from './commands/peek.js'
import { cmdSend } from './commands/send.js'
import { cmdStatus } from './commands/status.js'
import { cmdSummon } from './commands/summon.js'
import { cmdWait } from './commands/wait.js'
import { cmdWatch } from './commands/watch.js'
import { cmdWho } from './commands/who.js'

// -- .env.local loading -------------------------------------------------------

function loadDotEnvLocal(): void {
  const envPath = join(process.cwd(), '.env.local')
  let content: string
  try {
    content = readFileSync(envPath, 'utf8')
  } catch {
    return
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadDotEnvLocal()

// -- Client factory -----------------------------------------------------------

function createClient(): HrcClient {
  const socketPath = discoverSocket()
  return new HrcClient(socketPath)
}

// -- Main ---------------------------------------------------------------------

const USAGE = `hrcchat — semantic directed messaging for HRC agents

Usage:
  hrcchat who [--discover] [--all-projects] [--json]
  hrcchat summon <target> [--json]
  hrcchat dm <target|human|system> [message|-] [options]
  hrcchat send <target> [message|-] [--enter] [--no-enter] [--json]
  hrcchat messages [<target>] [filters] [--json]
  hrcchat watch [<target>] [--follow] [--timeout <dur>] [--json]
  hrcchat wait [filters] [--timeout <dur>] [--json]
  hrcchat peek <target> [--lines <n>] [--json]
  hrcchat status [<target>] [--json]
  hrcchat doctor [<target>] [--json]

Options:
  --project <id>   Override project context
  --json           Machine-readable JSON output
  --help           Show this help
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return
  }

  const subArgs = args.slice(1)

  try {
    const client = createClient()

    switch (command) {
      case 'who':
        await cmdWho(client, subArgs)
        break
      case 'summon':
        await cmdSummon(client, subArgs)
        break
      case 'dm':
        await cmdDm(client, subArgs)
        break
      case 'send':
        await cmdSend(client, subArgs)
        break
      case 'messages':
        await cmdMessages(client, subArgs)
        break
      case 'watch':
        await cmdWatch(client, subArgs)
        break
      case 'wait':
        await cmdWait(client, subArgs)
        break
      case 'peek':
        await cmdPeek(client, subArgs)
        break
      case 'status':
        await cmdStatus(client, subArgs)
        break
      case 'doctor':
        await cmdDoctor(client, subArgs)
        break
      default:
        fatal(`unknown command: ${command}\nRun 'hrcchat --help' for usage.`)
    }
  } catch (err) {
    if (err instanceof HrcDomainError) {
      fatal(`[${err.code}] ${err.message}`)
    }
    throw err
  }
}

main().catch((err) => {
  fatal(err instanceof Error ? err.message : String(err))
})
