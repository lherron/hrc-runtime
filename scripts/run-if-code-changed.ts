import { changeScope, classifyChange } from './lib/hook-change-scope.ts'
import { HOOK_SCOPE_IGNORE_FILE } from './lib/hook-scope-ignore.ts'
import { recordHookChange } from './lib/hook-timing.ts'

async function main(): Promise<number> {
  const separator = process.argv.indexOf('--', 2)
  const hook = process.argv[2]
  if ((hook !== 'pre-commit' && hook !== 'pre-push') || separator === -1) {
    console.error('usage: run-if-code-changed.ts <pre-commit|pre-push> -- <command> [args...]')
    return 2
  }
  const command = process.argv.slice(separator + 1)
  if (command.length === 0) {
    console.error('run-if-code-changed.ts requires a command after --')
    return 2
  }

  const scope = changeScope(hook, hook === 'pre-push' ? await Bun.stdin.text() : '')
  const change = classifyChange(scope)
  recordHookChange(change)
  if (change.kind === 'deletion_only') {
    console.log('[hook-scope] skipping validation for a deletion-only push')
    return 0
  }
  if (change.kind === 'documentation') {
    console.log(
      `[hook-scope] skipping code validation for ${change.fileCount} path(s) covered by ${HOOK_SCOPE_IGNORE_FILE}`
    )
    return 0
  }

  const result = Bun.spawnSync(command, {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return result.exitCode
}

process.exit(await main())
