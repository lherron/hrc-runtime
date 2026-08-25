import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type FakeCodexBehavior = {
  execDelayMs?: number
  execThreadId?: string
  interactiveBanner?: string
  interactiveDelayMs?: number
  resumeDelayMs?: number
}

export type FakeCodexDriver = {
  binDir: string
  logPath: string
  resumePath: string
}

export async function installFakeCodex(
  rootDir: string,
  dirName: string,
  behavior: {
    execDelayMs?: number
    execThreadId?: string
    interactiveBanner?: string
    interactiveDelayMs?: number
    resumeDelayMs?: number
  } = {}
): Promise<{ binDir: string; logPath: string; resumePath: string }> {
  const binDir = join(rootDir, dirName)
  const logPath = join(binDir, 'codex.log')
  const resumePath = join(binDir, 'resume.log')
  await mkdir(binDir, { recursive: true })
  const scriptPath = join(binDir, 'codex')
  await writeFile(
    scriptPath,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const logPath = ${JSON.stringify(logPath)}
const resumePath = ${JSON.stringify(resumePath)}
const execDelayMs = ${JSON.stringify(behavior.execDelayMs ?? 0)}
const execThreadId = ${JSON.stringify(behavior.execThreadId ?? 'thread-123')}
const interactiveBanner = ${JSON.stringify(behavior.interactiveBanner ?? 'INTERACTIVE_HARNESS_STARTED')}
const interactiveDelayMs = ${JSON.stringify(behavior.interactiveDelayMs ?? 1_500)}
const resumeDelayMs = ${JSON.stringify(behavior.resumeDelayMs ?? 0)}

function sleep(ms) {
return new Promise((resolve) => setTimeout(resolve, ms))
}

function stripRootFlags(input) {
const args = [...input]
while (args.length > 0) {
  const flag = args[0]
  if (flag === '--enable' || flag === '--disable' || flag === '--model' || flag === '-m' || flag === '-c') {
    args.splice(0, 2)
    continue
  }
  break
}
return args
}

function write(message) {
process.stdout.write(JSON.stringify(message) + '\\n')
}

function emitTurn() {
const turnId = 'turn-123'
const item = { id: 'msg-123', type: 'agentMessage', text: 'ok' }
write({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: turnId } } })
write({ jsonrpc: '2.0', method: 'item/completed', params: { turnId, item } })
write({
  jsonrpc: '2.0',
  method: 'thread/tokenUsage/updated',
  params: { tokenUsage: { input_tokens: 1, output_tokens: 1 } },
})
write({
  jsonrpc: '2.0',
  method: 'turn/completed',
  params: { turn: { id: turnId, status: 'completed', items: [item] } },
})
}

if (args[0] === '--version') {
console.log('codex 0.124.0')
process.exit(0)
}

const commandArgs = stripRootFlags(args)
const cmd = commandArgs[0] ?? ''

if (cmd === 'app-server' && commandArgs[1] === '--help') {
console.log('Usage: codex app-server')
process.exit(0)
}

if (cmd === 'app-server') {
appendFileSync(logPath, 'app-server:' + commandArgs.join(' ') + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  appendFileSync(logPath, 'stdin:' + line + '\\n')
  const message = JSON.parse(line)
  if (!('id' in message)) return
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'thread/start') {
    write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: execThreadId } } })
    return
  }
  if (message.method === 'thread/resume') {
    const threadId = message.params?.threadId ?? execThreadId
    appendFileSync(resumePath, 'resume:' + threadId + '\\n')
    write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: threadId } } })
    return
  }
  if (message.method === 'turn/start') {
    write({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-123' } } })
    setTimeout(emitTurn, execDelayMs)
    return
  }
})
rl.on('close', () => process.exit(0))
setTimeout(() => {}, 60_000)
} else if (cmd === 'resume') {
const resumeArgs = stripRootFlags(commandArgs.slice(1))
appendFileSync(resumePath, 'resume:' + (resumeArgs[0] ?? '') + '\\n')
await sleep(resumeDelayMs)
} else {
appendFileSync(logPath, 'interactive:' + args.join(' ') + '\\n')
console.log(interactiveBanner)
await sleep(interactiveDelayMs)
}
`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)
  process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`
  process.env['ASP_CODEX_PATH'] = scriptPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  return { binDir, logPath, resumePath }
}
