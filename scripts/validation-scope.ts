import { languageScope } from './lib/language-scope'

// Manual verify with no delta runs both. Otherwise inspect committed work and
// local edits, including new inputs; unknown/broken git scope fails closed.
const paths = new Set<string>()
let valid = true
for (const args of [
  ['diff', '--name-only', 'origin/main...HEAD'],
  ['diff', '--name-only', 'HEAD'],
  ['ls-files', '--others', '--exclude-standard'],
]) {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) valid = false
  for (const path of result.stdout.toString().trim().split('\n').filter(Boolean)) paths.add(path)
}
const legs = valid && paths.size > 0 ? languageScope([...paths]) : { ts: true, cargo: true }
console.log(`HRC_VERIFY_TS=${legs.ts ? 1 : 0}\nHRC_VERIFY_CARGO=${legs.cargo ? 1 : 0}`)
