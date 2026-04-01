import { postCallback } from './callback-client.js'
import { buildHookEnvelope } from './hook.js'
import { spoolCallback } from './spool.js'

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const stdinText = Buffer.concat(chunks).toString('utf-8')

  let stdinJson: unknown
  try {
    stdinJson = JSON.parse(stdinText)
  } catch {
    process.stderr.write('hrc-launch hook: invalid JSON on stdin\n')
    process.exit(1)
  }

  const launchId = process.env['HRC_LAUNCH_ID']
  const hostSessionId = process.env['HRC_HOST_SESSION_ID']
  const generationStr = process.env['HRC_GENERATION']
  const runtimeId = process.env['HRC_RUNTIME_ID']
  const socketPath = process.env['HRC_CALLBACK_SOCKET']
  const spoolDir = process.env['HRC_SPOOL_DIR']

  if (!launchId || !hostSessionId || !generationStr || !socketPath || !spoolDir) {
    process.stderr.write(
      'hrc-launch hook: missing required env vars (HRC_LAUNCH_ID, HRC_HOST_SESSION_ID, HRC_GENERATION, HRC_CALLBACK_SOCKET, HRC_SPOOL_DIR)\n'
    )
    process.exit(1)
  }

  const generation = Number.parseInt(generationStr, 10)
  if (Number.isNaN(generation)) {
    process.stderr.write(`hrc-launch hook: invalid HRC_GENERATION: ${generationStr}\n`)
    process.exit(1)
  }

  const envelope = buildHookEnvelope(stdinJson, {
    launchId,
    hostSessionId,
    generation,
    runtimeId: runtimeId || undefined,
  })

  const delivered = await postCallback(socketPath, '/v1/internal/hooks/ingest', envelope)
  if (!delivered) {
    await spoolCallback(spoolDir, launchId, {
      endpoint: '/v1/internal/hooks/ingest',
      payload: envelope,
    })
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`hrc-launch hook error: ${String(err)}\n`)
  process.exit(1)
})
