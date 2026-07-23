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
