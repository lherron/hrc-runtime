import { changeScope } from './lib/hook-change-scope'
import { languageScope } from './lib/language-scope'

const input = await Bun.stdin.text()
const scope = changeScope('pre-push', input)
if (!scope.deletionOnlyPush && (scope.ambiguous || languageScope(scope.paths).cargo)) {
  const check = Bun.spawnSync(['just', 'cargo-check'], { stdio: ['inherit', 'inherit', 'inherit'] })
  if (check.exitCode !== 0) process.exit(check.exitCode)
} else {
  console.log('[hook-scope] skipping cargo: no Rust/shared inputs changed')
}
// Preserve the existing best-effort push fact after the validation gate.
Bun.spawnSync(
  [
    'sh',
    '-c',
    'command -v wrkp >/dev/null 2>&1 && wrkp git push "$@" || true',
    'sh',
    ...process.argv.slice(2),
  ],
  {
    stdin: Buffer.from(input),
    stdout: 'inherit',
    stderr: 'inherit',
  }
)
