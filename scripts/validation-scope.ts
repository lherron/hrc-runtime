import { languageScope } from './lib/language-scope'

// Manual verify with no delta runs both. Otherwise inspect committed work and
// local edits, including new inputs; unknown/broken git scope fails closed.
// CI's fetched origin/main already equals HEAD. Its explicit push range owns
// that run's scope; comparing origin/main to HEAD there would check no delta.
const paths = new Set<string>()
const ci = process.env['GITHUB_ACTIONS'] === 'true'
const base = ci ? process.env['BEFORE'] : 'origin/main'
const head = ci ? process.env['SHA'] : 'HEAD'
const oid = /^[0-9a-f]{40}$/
let valid = !ci || (!!base && !!head && oid.test(base) && oid.test(head) && !/^0+$/.test(base))
for (const args of [
  ['diff', '--name-only', `${base}...${head}`],
  ['diff', '--name-only', 'HEAD'],
  ['ls-files', '--others', '--exclude-standard'],
]) {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) valid = false
  for (const path of result.stdout.toString().trim().split('\n').filter(Boolean)) paths.add(path)
}
const legs = valid && paths.size > 0 ? languageScope([...paths]) : { ts: true, cargo: true }
console.log(`HRC_VERIFY_TS=${legs.ts ? 1 : 0}\nHRC_VERIFY_CARGO=${legs.cargo ? 1 : 0}`)
