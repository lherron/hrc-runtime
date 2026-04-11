import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

import { postCallback } from './callback-client.js'
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

  w('')
  w(bold(`hrc launch ${artifact.env['AGENTCHAT_ID'] ?? artifact.launchId}`))
  w(dim(`  launch:   ${artifact.launchId}`))
  w(dim(`  runtime:  ${artifact.runtimeId}`))
  if (artifact.runId) w(dim(`  run:      ${artifact.runId}`))
  w(dim(`  cwd:      ${artifact.cwd}`))
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
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`
  }

  return String(err)
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
      cwd,
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
  const child: ChildProcess = spawn(command, argv.slice(1), {
    env: {
      ...process.env,
      ...env,
      HRC_LAUNCH_FILE: launchFile,
      HRC_CALLBACK_SOCKET: callbackSocketPath,
      HRC_CALLBACK_SOCK: callbackSocketPath,
      HRC_SPOOL_DIR: spoolDir,
      HRC_LAUNCH_ID: launchId,
      HRC_HOST_SESSION_ID: hostSessionId,
      HRC_GENERATION: String(generation),
      ...(runtimeId ? { HRC_RUNTIME_ID: runtimeId } : {}),
    },
    cwd,
    stdio: 'inherit',
  })

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

  // Deregister agent from agentchat on exit (best-effort).
  if (agentchatId && agentchatProject) {
    spawnSync('agentchat', ['--project', agentchatProject, 'deregister', '--id', agentchatId], {
      env: { ...process.env, ...env },
      cwd,
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
