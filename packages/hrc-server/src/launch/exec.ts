import { type ChildProcess, spawn } from 'node:child_process'
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

  // POST wrapper-started
  await callbackOrSpool(
    callbackSocketPath,
    `/v1/internal/launches/${launchId}/wrapper-started`,
    { launchId, hostSessionId, wrapperPid: process.pid },
    spoolDir,
    launchId
  )

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

  process.exit(exitCode)
}

main().catch((err: unknown) => {
  process.stderr.write(`hrc-launch exec error: ${String(err)}\n`)
  process.exit(1)
})
