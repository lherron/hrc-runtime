import { afterEach, beforeEach } from 'bun:test'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createHrcServer } from '../../index'
import type { HrcServer, HrcServerOptions } from '../../index'
import { createHrcTestFixture } from './hrc-test-fixture'
import type { HrcServerTestFixture } from './hrc-test-fixture'

export function createHrcchatMinimalFixture() {
  let fixture: HrcServerTestFixture
  let server: HrcServer
  let originalPath: string | undefined
  let originalAspCodexPath: string | undefined
  let originalAspCodexSkipCommonPaths: string | undefined

  beforeEach(async () => {
    originalPath = process.env['PATH']
    originalAspCodexPath = process.env['ASP_CODEX_PATH']
    originalAspCodexSkipCommonPaths = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
    fixture = await createHrcTestFixture('hrc-hrcchat-minimal-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    await server.stop()
    await fixture.cleanup()
    if (originalPath === undefined) {
      // EXCEPTION(T-07533): process.env requires delete to truly unset.
      // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (=undefined leaks string "undefined")
      delete process.env['PATH']
    } else {
      process.env['PATH'] = originalPath
    }
    if (originalAspCodexPath === undefined) {
      // EXCEPTION(T-07533): process.env requires delete to truly unset.
      // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
      delete process.env['ASP_CODEX_PATH']
    } else {
      process.env['ASP_CODEX_PATH'] = originalAspCodexPath
    }
    if (originalAspCodexSkipCommonPaths === undefined) {
      // EXCEPTION(T-07533): process.env requires delete to truly unset.
      // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
      delete process.env['ASP_CODEX_SKIP_COMMON_PATHS']
    } else {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalAspCodexSkipCommonPaths
    }
  })

  async function restartServer(overrides: Partial<HrcServerOptions>): Promise<void> {
    await server.stop()
    server = await createHrcServer(fixture.serverOpts(overrides))
  }

  async function installFakeCodex(dirName: string): Promise<{ binDir: string; logPath: string }> {
    const binDir = join(fixture.tmpDir, dirName)
    const logPath = join(binDir, 'codex.log')
    const scriptPath = join(binDir, 'codex')

    await mkdir(binDir, { recursive: true })
    await writeFile(
      scriptPath,
      `#!${process.execPath}
  import { appendFileSync } from 'node:fs'
  import { createInterface } from 'node:readline'

  const logPath = ${JSON.stringify(logPath)}
  const args = process.argv.slice(2)

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

  function emitTurn(threadId) {
  const turnId = 'turn-dm'
  const item = { id: 'msg-dm', type: 'agentMessage', text: 'ok' }
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
  console.log('codex 99.0.0')
  process.exit(0)
  }

  const commandArgs = stripRootFlags(args)
  const cmd = commandArgs[0] ?? ''
  if (cmd === 'app-server' && commandArgs[1] === '--help') {
  console.log('codex app-server help')
  process.exit(0)
  }

  if (cmd === 'app-server') {
  appendFileSync(logPath, 'app-server:' + commandArgs.join(' ') + '\\n')
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const message = JSON.parse(line)
    if (!('id' in message)) return
    if (message.method === 'initialize') {
      write({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }
    if (message.method === 'thread/start') {
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-dm' } } })
      return
    }
    if (message.method === 'thread/resume') {
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: message.params?.threadId ?? 'thread-dm' } } })
      return
    }
    if (message.method === 'turn/start') {
      const threadId = message.params?.threadId ?? 'thread-dm'
      write({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-dm' } } })
      emitTurn(threadId)
      return
    }
  })
  rl.on('close', () => process.exit(0))
  setTimeout(() => {}, 60_000)
  } else {
  appendFileSync(logPath, 'interactive:' + args.join(' ') + '\\n')
  }
  `,
      'utf-8'
    )
    await chmod(scriptPath, 0o755)
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`
    process.env['ASP_CODEX_PATH'] = scriptPath
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

    return { binDir, logPath }
  }
  return {
    get fixture() {
      return fixture
    },
    get server() {
      return server
    },
    restartServer,
    installFakeCodex,
  }
}
