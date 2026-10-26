/**
 * T-11822 front door: the plist edits behind `just front-door-enable` and
 * `just front-door-disable`. A fronted node runs Bun's job with
 * `--listen-socket <runtime>/hrc-bun.sock` and the rusthrc job on the public
 * hrc.sock; a direct node runs Bun on hrc.sock and no rusthrc job.
 *
 * Installed plists carry node-local keys and BTM attribution, so they are
 * edited as text in place: a plutil/PlistBuddy canonical rewrite is never used.
 * Reads go through `plutil -extract`; every write is linted first.
 *
 *   front-door.ts listen-args add <plist> <socket>   Bun listens on <socket>
 *   front-door.ts listen-args remove <plist>         Bun listens on hrc.sock
 *   front-door.ts render <template> <dst> <server-plist>
 *       Render the rusthrc plist with the server plist's HOME and HRC dirs, so
 *       the two jobs cannot disagree on runtime or state root.
 *   front-door.ts bun-socket <server-plist>          print the private socket path
 *   front-door.ts l1-logs <server-plist>
 *       Align Bun's StandardOutPath/StandardErrorPath with the repo template
 *       (<HOME>/praesidium/var/logs/hrc-runtime/hrc-server.{log,err.log}).
 *       Takes effect at the job's next bootstrap.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FLAG = '<string>--listen-socket</string>'

function fail(message: string): never {
  console.error(`[front-door] ${message}`)
  process.exit(1)
}

function lintAndWrite(path: string, text: string): void {
  const next = `${path}.front-door-next`
  writeFileSync(next, text)
  const lint = spawnSync('plutil', ['-lint', next], { encoding: 'utf8' })
  if (lint.status !== 0) fail(`refusing to write an invalid plist: ${lint.stdout}${lint.stderr}`)
  renameSync(next, path)
}

function programArguments(text: string): { start: number; end: number } {
  const key = text.indexOf('<key>ProgramArguments</key>')
  const start = key < 0 ? -1 : text.indexOf('<array>', key)
  const end = start < 0 ? -1 : text.indexOf('</array>', start)
  if (end < 0) fail('no ProgramArguments array')
  return { start, end }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Remove a `--listen-socket <value>` pair from ProgramArguments, if present. */
function withoutListenArgs(text: string): string {
  const { start, end } = programArguments(text)
  const lines = text.slice(start, end).split('\n')
  const index = lines.findIndex((line) => line.trim() === FLAG)
  if (index < 0) return text
  lines.splice(index, 2)
  return text.slice(0, start) + lines.join('\n') + text.slice(end)
}

function withListenArgs(text: string, socket: string): string {
  const base = withoutListenArgs(text)
  const { start, end } = programArguments(base)
  const body = base.slice(start, end)
  const last = body
    .split('\n')
    .filter((line) => line.trim().startsWith('<string>'))
    .pop()
  if (last === undefined) fail('empty ProgramArguments array')
  const indent = last.slice(0, last.length - last.trimStart().length)
  const insert = `${indent}${FLAG}\n${indent}<string>${escapeXml(socket)}</string>\n`
  // Insert after the final <string> line, before the closing </array> line.
  const lineStart = base.lastIndexOf('\n', end - 1) + 1
  return base.slice(0, lineStart) + insert + base.slice(lineStart)
}

function plistValue(plist: string, keyPath: string): string {
  const result = spawnSync('plutil', ['-extract', keyPath, 'raw', '-o', '-', plist], {
    encoding: 'utf8',
  })
  if (result.status !== 0) fail(`${plist} has no ${keyPath}`)
  return result.stdout.trim()
}

function bunSocket(serverPlist: string): string {
  return join(plistValue(serverPlist, 'EnvironmentVariables.HRC_RUNTIME_DIR'), 'hrc-bun.sock')
}

/** Replace the <string> value that follows `<key>${key}</key>`. */
function withKeyString(text: string, key: string, value: string): string {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`)
  if (!pattern.test(text)) fail(`no ${key} string`)
  return text.replace(pattern, `$1${escapeXml(value)}$2`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'listen-args' && rest[0] === 'add' && rest.length === 3) {
  const [, plist, socket] = rest as [string, string, string]
  if (!socket.startsWith('/')) fail(`listen socket must be absolute: ${socket}`)
  lintAndWrite(plist, withListenArgs(readFileSync(plist, 'utf8'), socket))
} else if (command === 'listen-args' && rest[0] === 'remove' && rest.length === 2) {
  const plist = rest[1] as string
  lintAndWrite(plist, withoutListenArgs(readFileSync(plist, 'utf8')))
} else if (command === 'render' && rest.length === 3) {
  const [template, dst, serverPlist] = rest as [string, string, string]
  const values: Record<string, string> = {
    __HOME__: plistValue(serverPlist, 'EnvironmentVariables.HOME'),
    __RUNTIME_DIR__: plistValue(serverPlist, 'EnvironmentVariables.HRC_RUNTIME_DIR'),
    __STATE_DIR__: plistValue(serverPlist, 'EnvironmentVariables.HRC_STATE_DIR'),
    __BUN_SOCKET__: bunSocket(serverPlist),
  }
  let text = readFileSync(template, 'utf8')
  for (const [placeholder, value] of Object.entries(values)) {
    text = text.split(placeholder).join(escapeXml(value))
  }
  if (text.includes('__')) fail(`unrendered placeholder left in ${template}`)
  lintAndWrite(dst, text)
} else if (command === 'bun-socket' && rest.length === 1) {
  console.log(bunSocket(rest[0] as string))
} else if (command === 'l1-logs' && rest.length === 1) {
  const plist = rest[0] as string
  const logs = join(
    plistValue(plist, 'EnvironmentVariables.HOME'),
    'praesidium/var/logs/hrc-runtime'
  )
  // launchd will not start a job whose log directory is missing.
  mkdirSync(logs, { recursive: true })
  let text = readFileSync(plist, 'utf8')
  text = withKeyString(text, 'StandardOutPath', join(logs, 'hrc-server.log'))
  text = withKeyString(text, 'StandardErrorPath', join(logs, 'hrc-server.err.log'))
  lintAndWrite(plist, text)
} else {
  fail(
    'usage: front-door.ts listen-args add <plist> <socket> | listen-args remove <plist> | render <template> <dst> <server-plist> | bun-socket <server-plist> | l1-logs <server-plist>'
  )
}
