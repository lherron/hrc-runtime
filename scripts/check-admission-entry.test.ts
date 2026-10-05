import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAdmissionEntry } from './check-admission-entry'

async function inspect(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'admission-seal-'))
  try {
    for (const [path, source] of Object.entries(files)) {
      const target = join(root, 'packages/hrc-server/src', path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, source)
    }
    return await checkAdmissionEntry(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const route = 'export async function executeInteractiveBrokerInputTurn(plan: AdmittedPlan) {}'
test('seal refuses named, aliased, re-exported and namespace executor imports', async () => {
  for (const source of [
    "import { executeInteractiveBrokerInputTurn } from './turn-admission/routes/input'",
    "import { executeInteractiveBrokerInputTurn as send } from './turn-admission/routes/input'",
    "export { executeInteractiveBrokerInputTurn as send } from './turn-admission/routes/input'",
    "import * as routes from './turn-admission/routes/input'",
    "import * as routes from './turn-admission/routes/input.ts'",
    "import send from './turn-admission/routes/input'",
    "export * from './turn-admission/routes/input'",
    "export * as routes from './turn-admission/routes/input'",
    "const routes = await import('./turn-admission/routes/input')",
  ]) {
    expect(
      (await inspect({ 'turn-admission/routes/input.ts': route, 'door-handlers.ts': source }))
        .violations
    ).not.toHaveLength(0)
  }
})
test('seal refuses legacy dispatch calls and plan forgery outside admission', async () => {
  for (const source of [
    'this.dispatchTurnForSession(session, intent, body)',
    'server["dispatchAdmittedTurnForSession"]?.(session, intent, body)',
    'const send = server.dispatchTurnForSession; send(session)',
    'const plan = raw as AdmittedPlan',
    "import { createAdmittedPlan as permit } from './turn-admission/plan'",
    "import { admissionRouteMethods as send } from './turn-admission/methods'",
  ])
    expect((await inspect({ 'door-handlers.ts': source })).violations).not.toHaveLength(0)
})
test('seal requires a nonoptional branded plan as first executor argument', async () => {
  for (const parameter of [
    'session: HrcSessionRecord',
    'plan?: AdmittedPlan',
    'plan: AdmittedPlan | undefined',
  ]) {
    expect(
      (
        await inspect({
          'turn-admission/routes/input.ts': `export async function executeInteractiveBrokerInputTurn(${parameter}) {}`,
        })
      ).violations
    ).not.toHaveLength(0)
  }
})
test('seal admits internal calls, bootstrap method tables and type-only options', async () => {
  const result = await inspect({
    'turn-admission/routes/input.ts': route,
    'turn-admission/methods.ts':
      "import { executeInteractiveBrokerInputTurn } from './routes/input'; export const admissionRouteMethods = { executeInteractiveBrokerInputTurn }",
    'index.ts': "import { admissionRouteMethods } from './turn-admission/methods'",
    'door-handlers.ts': "import type { InputOptions } from './turn-admission/routes/input'",
  })
  expect(result.violations).toEqual([])
  expect(result.files).toBe(4)
})
test('seal refuses an absent production corpus', async () => {
  expect((await inspect({})).violations).not.toHaveLength(0)
})
