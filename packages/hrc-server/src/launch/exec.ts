import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { accessSync, existsSync, constants as fsConstants } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { postCallback } from './callback-client.js'
import { injectCodexOtelConfig } from './codex-otel.js'
import { scrubInheritedEnv } from './env.js'
import { readLaunchArtifact } from './launch-artifact.js'
import { spoolCallback } from './spool.js'

async function callbackOrSpool(
  socketPath: string,
  endpoint: string,
  payload: object,
  spoolDir: string,
  launchId: string
): Promise<void> {
  const delivered = await postCallback(socketPath, endpoint, payload)
  if (!delivered) {
    await spoolCallback(spoolDir, launchId, { endpoint, payload })
  }
}

function printLaunchSummary(artifact: {
  launchId: string
  runtimeId: string
  runId?: string | undefined
  harness: string
  argv: string[]
  env: Record<string, string>
  cwd: string
}): void {
  const w = (s: string) => process.stdout.write(`${s}\n`)
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`

  // Extract system prompt and priming prompt from argv
  const sysIdx = artifact.argv.indexOf('--system-prompt')
  const systemPrompt = sysIdx !== -1 ? artifact.argv[sysIdx + 1] : undefined
  const dashIdx = artifact.argv.indexOf('--')
  const primingPrompt = dashIdx !== -1 ? artifact.argv[dashIdx + 1] : undefined
  const resumeId = extractCodexResumeId(artifact.harness, artifact.argv)
  const codexCommand =
    artifact.harness === 'codex-cli' ? formatShellCommand(artifact.argv) : undefined

  w('')
  w(bold(`hrc launch ${artifact.env['AGENTCHAT_ID'] ?? artifact.launchId}`))
  w(dim(`  launch:   ${artifact.launchId}`))
  w(dim(`  runtime:  ${artifact.runtimeId}`))
  if (artifact.runId) w(dim(`  run:      ${artifact.runId}`))
  w(dim(`  cwd:      ${artifact.cwd}`))
  if (artifact.harness === 'codex-cli' && artifact.env['CODEX_HOME']) {
    w(dim(`  codex home: ${artifact.env['CODEX_HOME']}`))
  }
  if (resumeId) {
    w(dim(`  resuming session: ${resumeId}`))
  }
  w('')

  if (systemPrompt) {
    w(cyan('── system prompt ──'))
    // Show first ~20 lines to keep output manageable
    const lines = systemPrompt.split('\n')
    const preview = lines.slice(0, 20)
    for (const line of preview) w(`  ${line}`)
    if (lines.length > 20) w(dim(`  ... (${lines.length - 20} more lines)`))
    w('')
  }

  if (primingPrompt) {
    w(cyan('── priming prompt ──'))
    const lines = primingPrompt.split('\n')
    const preview = lines.slice(0, 20)
    for (const line of preview) w(`  ${line}`)
    if (lines.length > 20) w(dim(`  ... (${lines.length - 20} more lines)`))
    w('')
  }

  // Show key env vars
  const keyVars = ['AGENTCHAT_ID', 'ASP_PROJECT', 'AGENTCHAT_TRANSPORT']
  const envDisplay = keyVars.filter((k) => artifact.env[k]).map((k) => `${k}=${artifact.env[k]}`)
  if (envDisplay.length > 0) {
    w(cyan('── env ──'))
    for (const e of envDisplay) w(`  ${e}`)
    w('')
  }

  if (codexCommand) {
    w(cyan('── command ──'))
    w(`  ${codexCommand}`)
    w('')
  }
}

function extractCodexResumeId(harness: string, argv: string[]): string | undefined {
  if (harness !== 'codex-cli') {
    return undefined
  }

  const resumeIdx = argv.indexOf('resume')
  if (resumeIdx === -1) {
    return undefined
  }

  const resumeId = argv[resumeIdx + 1]
  if (!resumeId || resumeId.startsWith('-')) {
    return undefined
  }

  return resumeId
}

function formatShellCommand(argv: string[]): string {
  return argv.map((arg) => quoteShellArg(arg)).join(' ')
}

function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) {
    return arg
  }

  return `'${arg.replace(/'/g, `'\"'\"'`)}'`
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`
  }

  return String(err)
}

function resolveExecutable(command: string, envPath: string | undefined): string {
  if (isAbsolute(command) || command.includes('/')) {
    return command
  }

  for (const entry of (envPath ?? '').split(delimiter)) {
    if (!entry) {
      continue
    }
    const candidate = join(entry, command)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // try next PATH entry
    }
  }

  return command
}

function isHeadlessCodexLaunch(artifact: {
  harness: string
  interactionMode?: 'headless' | 'interactive' | undefined
  ioMode?: 'inherit' | 'pipes' | 'pty' | undefined
}): boolean {
  return (
    artifact.harness === 'codex-cli' &&
    artifact.interactionMode === 'headless' &&
    artifact.ioMode === 'pipes'
  )
}

async function pumpHeadlessCodexOutput(
  stream: NodeJS.ReadableStream | null,
  artifact: {
    callbackSocketPath: string
    hostSessionId: string
    launchId: string
    spoolDir: string
  }
): Promise<void> {
  if (!stream) {
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let deliveredContinuation = false

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      if (deliveredContinuation) {
        continue
      }

      try {
        const parsed = JSON.parse(trimmed) as {
          event?: string
          type?: string
          thread_id?: string
          threadId?: string
        }
        const eventName = parsed.event ?? parsed.type
        const threadId = parsed.thread_id ?? parsed.threadId
        if (eventName === 'thread.started' && typeof threadId === 'string') {
          deliveredContinuation = true
          await callbackOrSpool(
            artifact.callbackSocketPath,
            `/v1/internal/launches/${artifact.launchId}/continuation`,
            {
              hostSessionId: artifact.hostSessionId,
              continuation: {
                provider: 'openai',
                key: threadId,
              },
              harnessSessionJson: {
                threadId,
              },
            },
            artifact.spoolDir,
            artifact.launchId
          )
        }
      } catch {
        // Ignore non-JSON output in headless mode.
      }
    }
  }
}

async function pumpToStderr(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (!stream) {
    return
  }

  for await (const chunk of stream) {
    if (chunk) {
      process.stderr.write(chunk)
    }
  }
}

async function applyLaunchCodexConfig(artifact: Awaited<ReturnType<typeof readLaunchArtifact>>) {
  if (artifact.harness !== 'codex-cli' || !artifact.otel) {
    return
  }

  const codexHome = artifact.env['CODEX_HOME']
  if (!codexHome) {
    return
  }

  const configPath = join(codexHome, 'config.toml')
  const existingConfig = existsSync(configPath) ? await readFile(configPath, 'utf-8') : ''
  const nextConfig = injectCodexOtelConfig(existingConfig, artifact.otel)
  await writeFile(configPath, nextConfig)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'launch-file': { type: 'string' },
    },
    strict: true,
  })

  const launchFile = values['launch-file']
  if (!launchFile) {
    process.stderr.write('Usage: hrc-launch exec --launch-file <path>\n')
    process.exit(1)
  }

  const artifact = await readLaunchArtifact(launchFile)
  const {
    launchId,
    callbackSocketPath,
    hostSessionId,
    generation,
    runtimeId,
    spoolDir,
    argv,
    env,
    cwd,
  } = artifact

  const command = argv[0]
  if (!command) {
    process.stderr.write('hrc-launch exec: empty argv in launch artifact\n')
    process.exit(1)
  }
  const effectiveCwd = existsSync(cwd) ? cwd : process.cwd()

  await applyLaunchCodexConfig(artifact)

  // Display launch summary before spawning the harness.
  printLaunchSummary(artifact)

  // POST wrapper-started
  await callbackOrSpool(
    callbackSocketPath,
    `/v1/internal/launches/${launchId}/wrapper-started`,
    { launchId, hostSessionId, wrapperPid: process.pid },
    spoolDir,
    launchId
  )

  // Register agent with agentchat before spawning the harness.
  // Requires AGENTCHAT_ID, ASP_PROJECT, AGENTCHAT_TRANSPORT, and
  // AGENTCHAT_TARGET in the launch env.  Best-effort: failures are
  // logged but do not block the harness from starting.
  const agentchatId = env['AGENTCHAT_ID']
  const agentchatProject = env['ASP_PROJECT']
  const agentchatTransport = env['AGENTCHAT_TRANSPORT']
  const agentchatTarget = env['AGENTCHAT_TARGET']
  if (agentchatId && agentchatProject && agentchatTransport && agentchatTarget) {
    const regArgs = [
      '--project',
      agentchatProject,
      'register',
      '--id',
      agentchatId,
      '--transport',
      agentchatTransport,
      '--target',
      agentchatTarget,
      '--force',
    ]
    process.stdout.write(`agentchat ${regArgs.join(' ')}\n`)
    const regResult = spawnSync('agentchat', regArgs, {
      env: { ...process.env, ...env },
      cwd: effectiveCwd,
      timeout: 5_000,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    if (regResult.status !== 0) {
      const stderr = regResult.stderr?.toString().trim()
      process.stderr.write(
        `hrc-launch exec: agentchat register failed (exit ${regResult.status}): ${stderr}\n`
      )
    }
  }

  // Spawn child
  const resolvedCommand = resolveExecutable(command, env['PATH'])
  const child: ChildProcess = spawn(resolvedCommand, argv.slice(1), {
    env: {
      ...scrubInheritedEnv(process.env),
      ...env,
      HRC_LAUNCH_FILE: launchFile,
      HRC_CALLBACK_SOCKET: callbackSocketPath,
      HRC_CALLBACK_SOCK: callbackSocketPath,
      HRC_SPOOL_DIR: spoolDir,
      HRC_LAUNCH_ID: launchId,
      HRC_HOST_SESSION_ID: hostSessionId,
      HRC_GENERATION: String(generation),
      HRC_LAUNCH_HOOK_CLI: fileURLToPath(new URL('./hook-cli.ts', import.meta.url)),
      ...(runtimeId ? { HRC_RUNTIME_ID: runtimeId } : {}),
    },
    cwd: effectiveCwd,
    stdio: isHeadlessCodexLaunch(artifact) ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  // Trap SIGHUP/SIGTERM so the wrapper survives tmux session teardown long
  // enough to post the exit callback.  The signal is forwarded to the child;
  // the wrapper exits after the callback completes (see handleTerminalState).
  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      child.kill(sig)
    })
  }

  const childStdout =
    isHeadlessCodexLaunch(artifact) && child.stdout
      ? pumpHeadlessCodexOutput(child.stdout, artifact)
      : Promise.resolve()
  const childStderr =
    isHeadlessCodexLaunch(artifact) && child.stderr ? pumpToStderr(child.stderr) : Promise.resolve()

  // POST child-started
  if (child.pid !== undefined) {
    await callbackOrSpool(
      callbackSocketPath,
      `/v1/internal/launches/${launchId}/child-started`,
      { launchId, hostSessionId, childPid: child.pid },
      spoolDir,
      launchId
    )
  }

  // Wait for exit
  const exitCode = await new Promise<number>((resolve) => {
    let settled = false

    const resolveOnce = (code: number): void => {
      if (!settled) {
        settled = true
        resolve(code)
      }
    }

    const handleTerminalState = (code: number | null, signal: string | null): void => {
      const resolvedCode = code ?? 1
      const payload = {
        launchId,
        hostSessionId,
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
      }
      callbackOrSpool(
        callbackSocketPath,
        `/v1/internal/launches/${launchId}/exited`,
        payload,
        spoolDir,
        launchId
      )
        .then(() => {
          resolveOnce(resolvedCode)
        })
        .catch((err: unknown) => {
          process.stderr.write(
            `hrc-launch exec: failed to post/spool exit callback: ${formatError(err)}\n`
          )
          resolveOnce(resolvedCode)
        })
    }

    child.on('error', (err: Error) => {
      process.stderr.write(`hrc-launch exec: spawn failed: ${formatError(err)}\n`)
      handleTerminalState(1, null)
    })

    child.on('exit', (code: number | null, signal: string | null) => {
      handleTerminalState(code, signal)
    })
  })

  await Promise.all([childStdout, childStderr])

  // Deregister agent from agentchat on exit (best-effort).
  if (agentchatId && agentchatProject) {
    spawnSync('agentchat', ['--project', agentchatProject, 'deregister', '--id', agentchatId], {
      env: { ...process.env, ...env },
      cwd: effectiveCwd,
      timeout: 5_000,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  }

  process.exit(exitCode)
}

main().catch((err: unknown) => {
  process.stderr.write(`hrc-launch exec error: ${String(err)}\n`)
  process.exit(1)
})
