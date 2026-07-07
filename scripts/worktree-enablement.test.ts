import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { parse } from 'smol-toml'

const manifestText = readFileSync('praesidium.toml', 'utf8')
const manifest = parse(manifestText) as {
  commands?: Record<string, unknown>
}

const justfileText = readFileSync('justfile', 'utf8')

const SIDE_EFFECT_TOKENS = [
  'sync:asp',
  'publish-dev',
  'bun link',
  'hrc server restart',
  'launchctl',
  'npm publish',
]

function command(name: 'prep' | 'install' | 'test'): string {
  const value = manifest.commands?.[name]
  expect(value, `praesidium.toml [commands].${name} must be present`).toBeString()
  return value as string
}

function recipeBody(name: string): string {
  const match = justfileText.match(new RegExp(`^${name}[^\\n]*:\\n((?:[ \\t].*\\n|\\s*\\n)*)`, 'm'))
  expect(match, `justfile recipe '${name}' must exist`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('worktree enablement manifest', () => {
  test('declares the complete bounded drain command family', () => {
    // T-05834: a drain target needs explicit prep/install/test entries; missing entries
    // let workflows close without exercising the real verifier bar.
    expect(command('prep').trim()).not.toBe('')
    expect(command('install').trim()).not.toBe('')
    expect(command('test').trim()).not.toBe('')
  })

  test('manifest commands stay worktree-local and omit install side effects', () => {
    // T-05834 / post-T-05831: linked-worktree validation must not mutate sibling
    // repos, global wrappers, service state, or ordinary dev publish channels.
    const commands = ['prep', 'install', 'test'].map((name) =>
      command(name as 'prep' | 'install' | 'test')
    )

    for (const manifestCommand of commands) {
      for (const forbidden of SIDE_EFFECT_TOKENS) {
        expect(manifestCommand).not.toContain(forbidden)
      }
    }
  })

  test('main-checkout install recipe still exposes the ordinary operator install path', () => {
    // Negative guard: the worktree-safe drain path must be separate from the
    // existing main-checkout operator install path, not achieved by silently
    // deleting publish/link/sync behavior from the documented main install.
    const installRecipe = recipeBody('install')

    expect(installRecipe).toContain('bun run sync:asp')
    expect(installRecipe).toContain('just publish-dev')
    expect(installRecipe).toContain('bun link')
  })
})
