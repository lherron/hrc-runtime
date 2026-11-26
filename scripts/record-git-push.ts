import { changeScope, classifyChange } from './lib/hook-change-scope'
import { recordHookChange } from './lib/hook-timing'

const input = Buffer.from(await Bun.stdin.arrayBuffer())
recordHookChange(classifyChange(changeScope('pre-push', input.toString())))

// Forward the git ref updates to the best-effort push fact recorder.
Bun.spawnSync(
  [
    'sh',
    '-c',
    'wrkp="$HOME/.local/bin/wrkp"; [ -x "$wrkp" ] && "$wrkp" git push "$@" || true',
    'sh',
    ...process.argv.slice(2),
  ],
  {
    stdin: input,
    stdout: 'inherit',
    stderr: 'inherit',
  }
)
