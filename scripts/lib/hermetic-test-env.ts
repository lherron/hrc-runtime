/**
 * The environment every test process starts with (T-10226).
 *
 * It has to be fixed BEFORE `bun test` starts, not inside it: bun (1.3.14)
 * hands a child spawned without an explicit `env` the environment the process
 * was STARTED with, ignoring every later write to `process.env`. A preload that
 * deletes GIT_DIR or overrides HRC_WRKQ_DB therefore changes what in-process
 * code reads and nothing that a `git`, `wrkq` or `hrc` child inherits — which
 * is how the suites kept shelling out to the production ledger (159a4c26) after
 * the preload claimed to have sealed it (T-08137), and how a fixture `git init`
 * under a hook's GIT_DIR rewrote the shared checkout (1432e482).
 *
 * `scripts/hermetic-test.ts` starts `bun test` with this environment;
 * `scripts/test-preload-hermetic-env.ts` refuses a run that bypassed it while a
 * repository-redirecting variable is set.
 */
import { environmentWithoutGitOverrides } from '../../packages/hrc-core/src/git-environment.ts'

/** Unreachable wrkq locator: connection refused, no wait. Also outranks WRKQ_DB_PATH. */
export const UNREACHABLE_WRKQ_LOCATOR = 'rpc://127.0.0.1:1'

/**
 * Variables that make git act on a repository other than the one a spawn named.
 * Git exports these to hooks; a test process must never carry them.
 */
export const REPOSITORY_REDIRECTING_GIT_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
] as const

export function hermeticTestEnvironment(
  inherited: Record<string, string | undefined> = process.env
): Record<string, string> {
  return { ...environmentWithoutGitOverrides(inherited), HRC_WRKQ_DB: UNREACHABLE_WRKQ_LOCATOR }
}

export function repositoryRedirectsIn(env: Record<string, string | undefined>): string[] {
  return REPOSITORY_REDIRECTING_GIT_VARIABLES.filter((key) => env[key] !== undefined)
}
