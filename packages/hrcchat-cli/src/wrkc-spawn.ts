/**
 * Thin process boundary for the `hrcchat dm` forwarding shim (T-07612 §9.2).
 *
 * wrkc is a Go binary in the wrkq repo with no HRC dependency, so the only
 * honest way to forward is to exec it. Kept separate from the argv mapping so
 * the mapping stays a pure, testable function.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { CliUsageError } from 'cli-kit'

import {
  type DmForwardOptions,
  closedRoomRecoveryHint,
  formatForwardNotice,
  mapDmToWrkcSay,
} from './wrkc-forward.js'

export async function forwardDmToWrkc(
  target: string,
  message: string | undefined,
  opts: DmForwardOptions
): Promise<never> {
  let body = message
  let stdinText: string | undefined
  if (opts.file !== undefined) {
    if (body !== undefined) {
      throw new CliUsageError('pass a message body or --file, not both')
    }
    stdinText = readFileSync(opts.file, 'utf8')
    body = '-'
  }

  const plan = mapDmToWrkcSay(target, body, opts)
  if (plan.kind === 'refuse') throw new CliUsageError(plan.message)

  process.stderr.write(formatForwardNotice(plan))

  // stderr is piped rather than inherited ONLY so a closed-room refusal can be
  // followed by its recovery. Everything wrkc writes is passed through verbatim
  // and in order first; nothing is swallowed or rewritten.
  const child = spawn('wrkc', plan.argv, {
    stdio: [stdinText === undefined ? 'inherit' : 'pipe', 'inherit', 'pipe'],
  })
  if (stdinText !== undefined && child.stdin) {
    child.stdin.end(stdinText)
  }
  let stderrText = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString()
    process.stderr.write(chunk)
  })

  return await new Promise<never>((_resolve, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new CliUsageError(
            'wrkc is not on PATH; hrcchat dm now forwards to it. Install wrkq (`just install` in ~/praesidium/wrkq).'
          )
        )
        return
      }
      reject(err)
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal as NodeJS.Signals)
        return
      }
      if (code !== 0) {
        const hint = closedRoomRecoveryHint(stderrText, plan.argv[1] ?? '<room>')
        if (hint !== undefined) process.stderr.write(hint)
      }
      process.exit(code ?? 0)
    })
  })
}
