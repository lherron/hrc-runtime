import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const runtimeRoot = process.env['HRC_RUNTIME_DIR']
if (runtimeRoot === undefined) {
  throw new Error('HRC_RUNTIME_DIR is required by the unhandled-rejection preload')
}

const deadline = Date.now() + 5_000
const timer = setInterval(() => {
  if (!existsSync(join(runtimeRoot, 'server.pid'))) {
    if (Date.now() >= deadline) {
      clearInterval(timer)
      process.stderr.write('T-07190 preload timed out waiting for a booted foreground server\n')
      process.exit(90)
    }
    return
  }

  clearInterval(timer)
  setTimeout(() => {
    writeFileSync(
      join(runtimeRoot, 'shutdown-intent.json'),
      `${JSON.stringify({
        action: 'restart',
        requestedBy: 'agent:test:project:hrc-runtime:task:primary/lane:main',
        requestedRunId: 'run-t07190',
        reason: 'exercise rejection attribution',
        byPid: process.pid + 1,
        at: new Date().toISOString(),
      })}\n`
    )

    Promise.reject(
      new Error('T-07190 outer rejection', {
        cause: new Error('T-07190 inner cause'),
      })
    )
    Promise.reject(new Error('T-07190 rejection during shutdown'))
  }, 25)
}, 5)
