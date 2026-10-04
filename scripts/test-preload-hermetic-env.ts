/**
 * Global test preload: keep operator-level environment out of unit tests.
 *
 * ASP_DEFAULT_TASK (agent-scope's ASP_DEFAULT_TASK_ENV) changes the resolver's
 * ultimate task default from "primary" to an operator-chosen task id. Lab
 * boxes export it in ~/.zshenv, so any test asserting canonical "primary"
 * resolution goes red there unless the var is scrubbed. Registered via each
 * package's bunfig.toml [test] preload; the hooks apply to every test file in
 * the run. Tests that want the env behavior can still set the var inside
 * their own test body or beforeEach — those run after this hook.
 */
import { afterEach, beforeEach } from 'bun:test'

import { hermeticTestEnvironment, repositoryRedirectsIn } from './lib/hermetic-test-env.ts'

/**
 * T-08137: tests that spawn a real `hrc server serve` hand it this process's
 * environment, and the daemon's production ledger client resolves wrkq from
 * HRC_WRKQ_DB — which operator shells export as the fleet wrkqd. A fixture
 * daemon then posted `server.*` facts onto the live hrc-runtime timeline.
 *
 * T-10226: writing process.env here reaches in-process readers and children
 * spawned with an explicit `env: process.env`, but NOT a child spawned without
 * one — bun hands those the environment the process started with. So the
 * environment is fixed before bun starts, by scripts/hermetic-test.ts (every
 * package `test` script). This preload repeats it for in-process readers and
 * refuses a run that bypassed the wrapper while git has pointed it at a
 * repository: under a hook, every unpatched fixture `git` spawn would act on
 * the shared checkout (1432e482 rewrote hrc-runtime's .git/config that way).
 */
const redirects = repositoryRedirectsIn(process.env)
if (redirects.length > 0) {
  throw new Error(
    `test process inherited ${redirects.join(', ')}; run tests through \`bun run test\` (scripts/hermetic-test.ts), which starts bun test without them`
  )
}
const hermetic = hermeticTestEnvironment(process.env)
for (const key of Object.keys(process.env)) {
  if (!(key in hermetic)) Reflect.deleteProperty(process.env, key)
}
process.env['HRC_WRKQ_DB'] = hermetic['HRC_WRKQ_DB']

// Name mirrors ASP_DEFAULT_TASK_ENV in agent-spaces packages/agent-scope
// (hardcoded here so the preload stays dependency-free for every package).
const ASP_DEFAULT_TASK_ENV = 'ASP_DEFAULT_TASK'

let savedDefaultTask: string | undefined

beforeEach(() => {
  savedDefaultTask = process.env[ASP_DEFAULT_TASK_ENV]
  Reflect.deleteProperty(process.env, ASP_DEFAULT_TASK_ENV)
})

afterEach(() => {
  if (savedDefaultTask === undefined) {
    Reflect.deleteProperty(process.env, ASP_DEFAULT_TASK_ENV)
  } else {
    process.env[ASP_DEFAULT_TASK_ENV] = savedDefaultTask
  }
})
