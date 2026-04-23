import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import TOML from '@iarna/toml'

import type { HrcLaunchArtifact } from 'hrc-core'

import { writeLaunchArtifact } from '../launch/launch-artifact'
import { readSpoolEntries } from '../launch/spool'

const EXEC_PATH = fileURLToPath(new URL('../launch/exec.ts', import.meta.url))

let tmpDir: string
const servers = new Set<Server>()

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-launch-exec-test-'))
})

afterEach(async () => {
  await Promise.all(
    Array.from(servers).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
  await rm(tmpDir, { recursive: true, force: true })
})

function makeArtifact(overrides: Partial<HrcLaunchArtifact> = {}): HrcLaunchArtifact {
  return {
    launchId: 'launch-exec-test-001',
    hostSessionId: 'hsid-exec-test-001',
    generation: 1,
    runtimeId: 'rt-exec-test-001',
    harness: 'claude-code',
    provider: 'anthropic',
    argv: [process.execPath, '-e', 'process.exit(0)'],
    env: { HOME: tmpDir, HRC_LAUNCH_ID: 'launch-exec-test-001' },
    cwd: tmpDir,
    callbackSocketPath: join(tmpDir, 'callbacks.sock'),
    spoolDir: join(tmpDir, 'spool'),
    correlationEnv: {
      HRC_HOST_SESSION_ID: 'hsid-exec-test-001',
      HRC_GENERATION: '1',
    },
    ...overrides,
  }
}

async function runExec(
  artifact: HrcLaunchArtifact,
  timeoutMs = 2_000,
  wrapperEnv: Record<string, string | undefined> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const launchFile = await writeLaunchArtifact(artifact, join(tmpDir, 'artifacts'))
  const proc = Bun.spawn([process.execPath, EXEC_PATH, '--launch-file', launchFile], {
    cwd: tmpDir,
    env: { ...process.env, ...wrapperEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const exitCode = await Promise.race<number>([
    proc.exited,
    new Promise<number>((_, reject) => {
      setTimeout(
        () => reject(new Error(`hrc-launch exec timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    }),
  ])

  const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)])
  return { exitCode, stdout, stderr }
}

async function readStream(stream: ReadableStream | null): Promise<string> {
  if (!stream) {
    return ''
  }

  return await new Response(stream).text()
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

describe('hrc-launch exec crash paths', () => {
  it('posts a continuation callback when headless codex emits legacy event-based thread.started JSONL', async () => {
    const launchId = 'launch-headless-continuation'
    const socketPath = join(tmpDir, 'callbacks.sock')
    const received: Array<{ url: string; body: unknown }> = []

    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk.toString()
      })
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          body: raw.length > 0 ? JSON.parse(raw) : {},
        })
        res.statusCode = 204
        res.end()
      })
    })
    await listenOnSocket(server, socketPath)

    const result = await runExec(
      makeArtifact({
        launchId,
        harness: 'codex-cli',
        provider: 'openai',
        callbackSocketPath: socketPath,
        argv: [
          process.execPath,
          '-e',
          [
            "process.stdout.write(JSON.stringify({event:'thread.started',thread_id:'thread-123'}) + '\\n')",
            'process.exit(0)',
          ].join('\n'),
        ],
        env: {
          HOME: tmpDir,
          HRC_LAUNCH_ID: launchId,
        },
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as HrcLaunchArtifact)
    )

    expect(result.exitCode).toBe(0)
    expect(
      received.some(
        (entry) =>
          entry.url === `/v1/internal/launches/${launchId}/continuation` &&
          (entry.body as { continuation?: { provider?: string; key?: string } }).continuation
            ?.provider === 'openai' &&
          (entry.body as { continuation?: { provider?: string; key?: string } }).continuation
            ?.key === 'thread-123'
      )
    ).toBe(true)
  })

  it('posts a continuation callback when headless codex emits real type-based thread.started JSONL', async () => {
    const launchId = 'launch-headless-continuation-real-codex'
    const socketPath = join(tmpDir, 'callbacks.sock')
    const received: Array<{ url: string; body: unknown }> = []

    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk.toString()
      })
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          body: raw.length > 0 ? JSON.parse(raw) : {},
        })
        res.statusCode = 204
        res.end()
      })
    })
    await listenOnSocket(server, socketPath)

    const result = await runExec(
      makeArtifact({
        launchId,
        harness: 'codex-cli',
        provider: 'openai',
        callbackSocketPath: socketPath,
        argv: [
          process.execPath,
          '-e',
          [
            "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'thread-123'}) + '\\n')",
            'process.exit(0)',
          ].join('\n'),
        ],
        env: {
          HOME: tmpDir,
          HRC_LAUNCH_ID: launchId,
        },
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as HrcLaunchArtifact)
    )

    expect(result.exitCode).toBe(0)
    expect(
      received.some(
        (entry) =>
          entry.url === `/v1/internal/launches/${launchId}/continuation` &&
          (entry.body as { continuation?: { provider?: string; key?: string } }).continuation
            ?.provider === 'openai' &&
          (entry.body as { continuation?: { provider?: string; key?: string } }).continuation
            ?.key === 'thread-123'
      )
    ).toBe(true)
  })

  it('posts assistant message_end callbacks for codex agent_message JSONL events', async () => {
    const launchId = 'launch-headless-agent-message-real-codex'
    const socketPath = join(tmpDir, 'callbacks.sock')
    const received: Array<{ url: string; body: unknown }> = []

    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk.toString()
      })
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          body: raw.length > 0 ? JSON.parse(raw) : {},
        })
        res.statusCode = 204
        res.end()
      })
    })
    await listenOnSocket(server, socketPath)

    const result = await runExec(
      makeArtifact({
        launchId,
        harness: 'codex-cli',
        provider: 'openai',
        callbackSocketPath: socketPath,
        argv: [
          process.execPath,
          '-e',
          [
            "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'thread-123'}) + '\\n')",
            "process.stdout.write(JSON.stringify({type:'turn.started'}) + '\\n')",
            "process.stdout.write(JSON.stringify({type:'item.completed',item:{id:'item_0',type:'agent_message',text:'ok'}}) + '\\n')",
            "process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}) + '\\n')",
            'process.exit(0)',
          ].join('\n'),
        ],
        env: {
          HOME: tmpDir,
          HRC_LAUNCH_ID: launchId,
        },
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as HrcLaunchArtifact)
    )

    expect(result.exitCode).toBe(0)
    expect(received.map((entry) => entry.url)).toEqual([
      `/v1/internal/launches/${launchId}/wrapper-started`,
      `/v1/internal/launches/${launchId}/child-started`,
      `/v1/internal/launches/${launchId}/continuation`,
      `/v1/internal/launches/${launchId}/event`,
      `/v1/internal/launches/${launchId}/exited`,
    ])
    expect(received[2]?.body).toEqual({
      hostSessionId: 'hsid-exec-test-001',
      continuation: {
        provider: 'openai',
        key: 'thread-123',
      },
      harnessSessionJson: {
        threadId: 'thread-123',
      },
    })
    expect(received[3]?.body).toEqual({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      },
    })
  })

  it('prints CODEX_HOME in the summary for codex launches', async () => {
    const codexHome = join(tmpDir, 'codex-home')
    const result = await runExec(
      makeArtifact({
        harness: 'codex-cli',
        provider: 'openai',
        env: {
          HOME: tmpDir,
          HRC_LAUNCH_ID: 'launch-exec-test-001',
          CODEX_HOME: codexHome,
        },
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`codex home: ${codexHome}`)
  })

  it('injects launch-scoped OTEL config into CODEX_HOME/config.toml before spawning codex', async () => {
    const codexHome = join(tmpDir, 'codex-home')
    const authHeaderValue = ['launch-exec-test-001', 'testsecret'].join('_')
    await mkdir(codexHome, { recursive: true })
    await Bun.write(
      join(codexHome, 'config.toml'),
      [
        'model = "gpt-5.5"',
        'approval_policy = "never"',
        '',
        '[projects."/tmp/workspace"]',
        'trust_level = "trusted"',
        '',
      ].join('\n')
    )

    const result = await runExec(
      makeArtifact({
        harness: 'codex-cli',
        provider: 'openai',
        env: {
          HOME: tmpDir,
          HRC_LAUNCH_ID: 'launch-exec-test-001',
          CODEX_HOME: codexHome,
        },
        otel: {
          transport: 'otlp-http-json',
          endpoint: 'http://127.0.0.1:4318/v1/logs',
          authHeaderName: 'x-hrc-launch-auth',
          authHeaderValue,
          secret: 'secret',
        },
        argv: [process.execPath, '-e', 'process.exit(0)'],
      })
    )

    expect(result.exitCode).toBe(0)

    const configRaw = await readFile(join(codexHome, 'config.toml'), 'utf-8')
    const parsed = TOML.parse(configRaw) as Record<string, unknown>
    expect(parsed['model']).toBe('gpt-5.5')
    expect(parsed['approval_policy']).toBe('never')

    const otel = parsed['otel'] as Record<string, unknown>
    expect(otel['environment']).toBe('hrc')
    expect(otel['log_user_prompt']).toBe(true)
    expect(otel['metrics_exporter']).toBe('none')
    expect(otel['trace_exporter']).toBe('none')

    const exporter = (otel['exporter'] as Record<string, unknown>)['otlp-http'] as Record<
      string,
      unknown
    >
    expect(exporter['endpoint']).toBe('http://127.0.0.1:4318/v1/logs')
    expect(exporter['protocol']).toBe('json')
    expect((exporter['headers'] as Record<string, unknown>)['x-hrc-launch-auth']).toBe(
      authHeaderValue
    )

    const projects = parsed['projects'] as Record<string, unknown>
    expect((projects['/tmp/workspace'] as Record<string, unknown>)['trust_level']).toBe('trusted')
  })

  it('prints the resume session id in the summary for codex resume launches', async () => {
    const result = await runExec(
      makeArtifact({
        harness: 'codex-cli',
        provider: 'openai',
        argv: [process.execPath, '-e', 'process.exit(0)', 'resume', 'abcd-efgh-ijkl'],
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('── command ──')
    expect(result.stdout).toContain(
      `${process.execPath} -e 'process.exit(0)' resume abcd-efgh-ijkl`
    )
    expect(result.stdout).toContain('resuming session: abcd-efgh-ijkl')
  })

  it('does not print CODEX_HOME for non-codex launches', async () => {
    const codexHome = join(tmpDir, 'codex-home')
    const result = await runExec(
      makeArtifact({
        env: {
          HOME: tmpDir,
          HRC_LAUNCH_ID: 'launch-exec-test-001',
          CODEX_HOME: codexHome,
        },
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain(`codex home: ${codexHome}`)
  })

  it('scrubs inherited color, ci, and stale codex vars before spawning the child', async () => {
    const wantedCodexHome = join(tmpDir, 'wanted-codex-home')
    const result = await runExec(
      makeArtifact({
        harness: 'codex-cli',
        provider: 'openai',
        argv: [
          process.execPath,
          '-e',
          [
            'process.stdout.write(JSON.stringify({',
            '  noColor: process.env.NO_COLOR ?? null,',
            '  codexCi: process.env.CODEX_CI ?? null,',
            '  codexHome: process.env.CODEX_HOME ?? null,',
            '  hrcRunId: process.env.HRC_RUN_ID ?? null,',
            '  agentchatId: process.env.AGENTCHAT_ID ?? null,',
            '}))',
          ].join('\n'),
        ],
        env: {
          HOME: tmpDir,
          CODEX_HOME: wantedCodexHome,
          AGENTCHAT_ID: 'larry',
        },
      }),
      2_000,
      {
        AGENTCHAT_ID: 'cody',
        CODEX_CI: '1',
        CODEX_HOME: '/tmp/stale-codex-home',
        HRC_RUN_ID: 'run-stale',
        NO_COLOR: '1',
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      JSON.stringify({
        noColor: null,
        codexCi: null,
        codexHome: wantedCodexHome,
        hrcRunId: null,
        agentchatId: 'larry',
      })
    )
  })

  it('exports HRC_LAUNCH_HOOK_CLI to the child harness env', async () => {
    const result = await runExec(
      makeArtifact({
        argv: [
          process.execPath,
          '-e',
          [
            'process.stdout.write(JSON.stringify({',
            '  hookCli: process.env.HRC_LAUNCH_HOOK_CLI ?? null,',
            '}))',
          ].join('\n'),
        ],
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      JSON.stringify({
        hookCli: fileURLToPath(new URL('../launch/hook-cli.ts', import.meta.url)),
      })
    )
  })

  it('spools an exited callback when spawn emits an error', async () => {
    const launchId = 'launch-spawn-error'
    const spoolDir = join(tmpDir, 'spool')
    const result = await runExec(
      makeArtifact({
        launchId,
        callbackSocketPath: join(tmpDir, 'missing.sock'),
        spoolDir,
        argv: [join(tmpDir, 'does-not-exist')],
      })
    )

    expect(result.exitCode).toBe(1)

    const entries = await readSpoolEntries(spoolDir, launchId)
    const endpoints = entries.map((entry) => (entry.payload as { endpoint?: string }).endpoint)

    expect(endpoints).toContain(`/v1/internal/launches/${launchId}/wrapper-started`)
    expect(endpoints).toContain(`/v1/internal/launches/${launchId}/exited`)
    expect(endpoints).not.toContain(`/v1/internal/launches/${launchId}/child-started`)

    const exitedEntry = entries.find(
      (entry) =>
        (entry.payload as { endpoint?: string }).endpoint ===
        `/v1/internal/launches/${launchId}/exited`
    )
    expect((exitedEntry?.payload as { payload?: { exitCode?: number } }).payload?.exitCode).toBe(1)
  })

  it('logs exit callback failures and still exits with the child code', async () => {
    const launchId = 'launch-exit-callback-failure'
    const socketPath = join(tmpDir, 'callbacks.sock')
    const spoolDir = join(tmpDir, 'blocked-spool')
    const requests: string[] = []

    await writeFile(spoolDir, 'not-a-directory', 'utf-8')

    const server = createServer((req, res) => {
      requests.push(req.url ?? '')
      res.statusCode = 204
      res.end(() => {
        if (requests.length === 2) {
          server.close()
        }
      })
    })
    await listenOnSocket(server, socketPath)

    const result = await runExec(
      makeArtifact({
        launchId,
        callbackSocketPath: socketPath,
        spoolDir,
        argv: [process.execPath, '-e', 'setTimeout(() => process.exit(7), 50)'],
      })
    )

    expect(result.exitCode).toBe(7)
    expect(result.stderr).toContain('failed')
    expect(requests).toEqual([
      `/v1/internal/launches/${launchId}/wrapper-started`,
      `/v1/internal/launches/${launchId}/child-started`,
    ])
  })
})
