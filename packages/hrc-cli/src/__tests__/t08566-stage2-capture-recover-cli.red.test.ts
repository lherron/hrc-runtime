/** T-08566 D4/D5/D9: explicit recovery and disposition CLI grammar. */
import { expect, test } from 'bun:test'
import { runCli } from './fixtures/cli.fixture'

const RUNTIME_ID = 'rt-11111111-1111-4111-8111-111111111111'

test('existing capture status command remains registered (positive control)', async () => {
  const result = await runCli(['capture', 'status', '--help'])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('read the broker-authoritative capture state')
})

test('capture recover requires --yes unless it is a dry-run', async () => {
  const unconfirmed = await runCli(['capture', 'recover', RUNTIME_ID, '--json'])
  expect(unconfirmed.exitCode).toBe(2)
  expect(unconfirmed.stderr).toContain('capture recover requires --yes')

  const dryRun = await runCli(['capture', 'recover', RUNTIME_ID, '--dry-run', '--json'])
  expect(dryRun.stderr).not.toContain("unknown command 'recover'")
  expect(dryRun.exitCode).not.toBe(2)
})

test('capture recover exposes operator trigger and structured JSON contract', async () => {
  const result = await runCli(['capture', 'recover', RUNTIME_ID, '--yes', '--json'])
  expect(result.stderr).not.toContain("unknown command 'recover'")
  expect(result.exitCode).not.toBe(2)
})

test('runtime prune exposes retained-evidence disposal with a required reason', async () => {
  const help = await runCli(['runtime', 'prune', '--help'])
  expect(help.exitCode).toBe(0)
  expect(help.stdout).toContain('--dispose-retained-evidence')
  expect(help.stdout).toContain('--reason <text>')
})
