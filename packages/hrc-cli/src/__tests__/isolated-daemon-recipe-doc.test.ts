import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const repoRoot = new URL('../../../..', import.meta.url)
const recipeUrl = new URL('docs/isolated-daemon-smoke-recipe.md', repoRoot)
const agentsUrl = new URL('AGENTS.md', repoRoot)

test('documents the isolated-daemon smoke recipe and links it from AGENTS.md', () => {
  expect(existsSync(recipeUrl)).toBe(true)
  expect(existsSync(agentsUrl)).toBe(true)

  const recipe = readFileSync(recipeUrl, 'utf8')
  const agents = readFileSync(agentsUrl, 'utf8')

  for (const token of [
    'HRC_RUNTIME_DIR',
    'HRC_STATE_DIR',
    'HRC_HEADLESS_CODEX_BROKER_ENABLED',
    'server serve',
    '--daemon',
  ]) {
    expect(recipe).toContain(token)
  }
  expect(agents).toContain('docs/isolated-daemon-smoke-recipe.md')
})
