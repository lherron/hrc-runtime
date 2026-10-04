#!/usr/bin/env bun
/**
 * `bun test` with the hermetic test environment (T-10226). Every package's
 * `test` script and the root `test:scripts` run through here; arguments pass
 * through unchanged. See scripts/lib/hermetic-test-env.ts for why the
 * environment cannot be fixed from inside the test process.
 */
import { hermeticTestEnvironment } from './lib/hermetic-test-env.ts'

const child = Bun.spawn([process.execPath, 'test', ...process.argv.slice(2)], {
  env: hermeticTestEnvironment(process.env),
  stdio: ['inherit', 'inherit', 'inherit'],
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal))
}
process.exit(await child.exited)
