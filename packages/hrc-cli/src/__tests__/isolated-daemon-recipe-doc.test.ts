import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const repoRoot = new URL('../../../..', import.meta.url)
const recipeUrl = new URL('docs/isolated-daemon-smoke-recipe.md', repoRoot)
// The docs index is the recipe's home; T-11989 trimmed it from AGENTS.md.
const indexUrl = new URL('docs/README.md', repoRoot)

test('documents the isolated-daemon smoke recipe and links it from the docs index', () => {
  expect(existsSync(recipeUrl)).toBe(true)
  expect(existsSync(indexUrl)).toBe(true)

  const recipe = readFileSync(recipeUrl, 'utf8')
  const index = readFileSync(indexUrl, 'utf8')

  for (const token of [
    'HRC_RUNTIME_DIR',
    'HRC_STATE_DIR',
    'HRC_HEADLESS_CODEX_BROKER_ENABLED',
    'server serve',
    '--daemon',
  ]) {
    expect(recipe).toContain(token)
  }
  expect(index).toContain('](isolated-daemon-smoke-recipe.md)')
})
