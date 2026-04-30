import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { accessSync, existsSync, constants as fsConstants } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import type { HrcLaunchPromptMaterial } from 'hrc-core'
import { displayPrompts, formatDisplayCommand, renderKeyValueSection } from 'spaces-execution'

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

interface LaunchPrintArtifact {
  launchId: string
  runtimeId: string
  runId?: string | undefined
  harness: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  prompts?: HrcLaunchPromptMaterial | undefined
}

/**
 * Pull the system prompt out of argv. Claude uses --append-system-prompt;
 * other harnesses use --system-prompt. Returned along with the mode so the
 * framed section can label it correctly.
 */
function extractSystemPrompt(
  argv: string[]
): { content: string; mode: 'append' | 'replace' } | undefined {
  const appendIdx = argv.indexOf('--append-system-prompt')
  if (appendIdx !== -1 && argv[appendIdx + 1] !== undefined) {
    return { content: argv[appendIdx + 1] as string, mode: 'append' }
  }
  const replaceIdx = argv.indexOf('--system-prompt')
  if (replaceIdx !== -1 && argv[replaceIdx + 1] !== undefined) {
    return { content: argv[replaceIdx + 1] as string, mode: 'replace' }
  }
  return undefined
}

/**
 * Pull the priming prompt: convention is the value after `--`.
 */
function extractPrimingPrompt(argv: string[]): string | undefined {
  const dashIdx = argv.indexOf('--')
  if (dashIdx === -1) {
    return undefined
  }
  const value = argv[dashIdx + 1]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function promptSystemFromArtifact(
  prompts: HrcLaunchPromptMaterial | undefined
): { content: string; mode: 'append' | 'replace' } | undefined {
  const content = prompts?.system?.content
  if (!content) {
    return undefined
  }
  return {
    content,
    mode: prompts.system?.mode ?? 'append',
  }
}

function promptPrimingFromArtifact(
  prompts: HrcLaunchPromptMaterial | undefined
): string | undefined {
  const content = prompts?.priming?.content
  return content && content.length > 0 ? content : undefined
}

/**
 * Print the launch header + framed prompt sections + env block.
 * The harness command is printed separately (after the agentchat
 * register printout) by `printLaunchCommand`.
 */
async function printLaunchHeader(artifact: LaunchPrintArtifact): Promise<void> {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

  // Title prints above the framed prompts; launch metadata (IDs, cwd,
  // env vars) lives below them so the prompts get visual priority.
  const titleLines: string[] = ['']
  titleLines.push(bold(`hrc launch ${artifact.env['AGENTCHAT_ID'] ?? artifact.launchId}`))

  const sysPrompt = promptSystemFromArtifact(artifact.prompts) ?? extractSystemPrompt(artifact.argv)
  const primingPrompt =
    promptPrimingFromArtifact(artifact.prompts) ?? extractPrimingPrompt(artifact.argv)

  const metadataLines: string[] = ['']
  metadataLines.push(dim(`  launch:   ${artifact.launchId}`))
  metadataLines.push(dim(`  runtime:  ${artifact.runtimeId}`))
  if (artifact.runId) metadataLines.push(dim(`  run:      ${artifact.runId}`))
  metadataLines.push(dim(`  cwd:      ${artifact.cwd}`))
  if (artifact.harness === 'codex-cli' && artifact.env['CODEX_HOME']) {
    metadataLines.push(dim(`  codex home: ${artifact.env['CODEX_HOME']}`))
  }
  const resumeId = extractCodexResumeId(artifact.harness, artifact.argv)
  if (resumeId) {
    metadataLines.push(dim(`  resuming session: ${resumeId}`))
  }

  const keyVars = ['AGENTCHAT_ID', 'ASP_PROJECT', 'AGENTCHAT_TRANSPORT']
  const envEntries: Array<[string, string]> = keyVars
    .filter((k) => artifact.env[k])
    .map((k) => [k, artifact.env[k] as string])
  const envBlock = renderKeyValueSection('env', envEntries)
  if (envBlock.length > 0) {
    metadataLines.push('')
    metadataLines.push(...envBlock)
  }

  await displayPrompts({
    headerLines: titleLines,
    systemPrompt: sysPrompt?.content,
    systemPromptMode: sysPrompt?.mode,
    primingPrompt,
    betweenLines: metadataLines,
  })
}

/**
 * Print the resolved harness command line (with `<N chars>` placeholders
 * for long prompt args). Called after the agentchat register printout.
 */
function printLaunchCommand(artifact: LaunchPrintArtifact): void {
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
  const command = formatDisplayCommand(artifact.argv[0] as string, artifact.argv.slice(1))
  process.stdout.write('\n')
  process.stdout.write(`${cyan('── command ──')}\n`)
  process.stdout.write(`${command}\n`)
  process.stdout.write('\n')
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

      try {
        const parsed = JSON.parse(trimmed) as {
          event?: string
          type?: string
          thread_id?: string
          threadId?: string
          item?: {
            type?: string
            text?: string
          }
        }
        const eventName = parsed.event ?? parsed.type
        const threadId = parsed.thread_id ?? parsed.threadId
        if (
          !deliveredContinuation &&
          eventName === 'thread.started' &&
          typeof threadId === 'string'
        ) {
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
          continue
        }

        if (
          eventName === 'item.completed' &&
          parsed.item?.type === 'agent_message' &&
          typeof parsed.item.text === 'string'
        ) {
          await callbackOrSpool(
            artifact.callbackSocketPath,
            `/v1/internal/launches/${artifact.launchId}/event`,
            {
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: parsed.item.text }],
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
  if (!existsSync(cwd)) {
    process.stderr.write(
      `hrc-launch exec: launch cwd does not exist: ${cwd}\n  The launch artifact specified a cwd that is not present on disk.\n  Check the invocation cwd or the project marker (asp-targets.toml).\n`
    )
    process.exit(1)
  }

  await applyLaunchCodexConfig(artifact)

  // Print launch header + framed prompts before agentchat register so the
  // user sees what is about to run. The resolved harness command is printed
  // separately, after the agentchat register printout.
  await printLaunchHeader(artifact)

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
      cwd: cwd,
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

  // Print resolved harness command after the agentchat printout so the
  // user sees exactly what is about to be spawned (long prompt args are
  // collapsed to `<N chars>` placeholders).
  printLaunchCommand(artifact)

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
    cwd: cwd,
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
      cwd: cwd,
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
