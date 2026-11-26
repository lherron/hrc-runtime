import { changeScope } from './lib/hook-change-scope'
import { languageScope } from './lib/language-scope'

// Manual verify with no delta runs both. Otherwise inspect committed work and
// local edits, including new inputs; unknown/broken git scope fails closed.
// CI's fetched origin/main already equals HEAD. Its explicit push range owns
// that run's scope; comparing origin/main to HEAD there would check no delta.
const paths = new Set<string>()
const ci = process.env['GITHUB_ACTIONS'] === 'true'
const oid = /^[0-9a-f]{40}$/
let valid = true
if (ci) {
  const before = process.env['BEFORE'] ?? ''
  const sha = process.env['SHA'] ?? ''
  if (oid.test(before) && oid.test(sha) && !/^0+$/.test(before)) {
    // A net diff misses paths changed and then reverted in the same push.
    const scope = changeScope('pre-push', `refs/heads/main ${sha} refs/heads/main ${before}\n`)
    valid = !scope.ambiguous
    for (const path of scope.paths) paths.add(path)
  } else {
    valid = false
  }
}
for (const args of [
  ...(ci ? [] : [['diff', '--name-only', 'origin/main...HEAD']]),
  ['diff', '--name-only', 'HEAD'],
  ['ls-files', '--others', '--exclude-standard'],
]) {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) valid = false
  for (const path of result.stdout.toString().trim().split('\n').filter(Boolean)) paths.add(path)
}
const legs = valid && paths.size > 0 ? languageScope([...paths]) : { ts: true, cargo: true }
console.log(`HRC_VERIFY_TS=${legs.ts ? 1 : 0}\nHRC_VERIFY_CARGO=${legs.cargo ? 1 : 0}`)
