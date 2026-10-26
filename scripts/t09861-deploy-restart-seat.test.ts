/**
 * T-09861 §5 (FM35): the deploy lane keeps install and restart in ONE recipe
 * invocation, but the restart runs in the invoking seat's own process through
 * the lifecycle endpoint (`hrc server restart --node <expected-node>`), never
 * inside the ssh shell — which carries no runtime identity and would be refused.
 * A refused restart must fail the recipe (set -e), not be swallowed. Phase 2 is
 * the shared `_node-readback` recipe (T-11930), which the owner switch reuses.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const justfile = readFileSync(join(import.meta.dir, '..', 'justfile'), 'utf8')
function recipeBody(signature: string): string {
  const start = justfile.indexOf(signature)
  return justfile.slice(start, justfile.indexOf('\n# ', start + 1))
}
const recipe = recipeBody('_deploy-node ssh-target expected-node')
const readback = recipeBody('_node-readback ssh-target expected-node')
const remoteBlocks = [
  ...`${recipe}${readback}`.matchAll(/<<'REMOTE'([\s\S]*?)\n {4}REMOTE\n/g),
].map((m) => m[1] ?? '')
const localScript = recipe.replace(/<<'REMOTE'[\s\S]*?\n {4}REMOTE\n/g, '')

describe('T-09861 deploy restart runs as the invoking seat', () => {
  test('the recipe has two ssh phases around one local restart', () => {
    expect(remoteBlocks).toHaveLength(2)
    expect(localScript).toContain("hrc server restart --node '{{ expected-node }}'")
    expect(localScript).toContain('--reason "deploy {{ expected-node }} to ${target_sha}"')
    expect(localScript).toMatch(/set -euo pipefail/)
    expect(localScript).toContain('just _node-readback "{{ ssh-target }}" "{{ expected-node }}"')
  })

  test('no ssh phase restarts, stops or kickstarts the daemon', () => {
    for (const block of remoteBlocks) {
      // Commands only; the repair hint in a fail message may name the verb.
      expect(block).not.toMatch(/^\s*(?:"\$\{[^}]+\}"\s+)?hrc server (restart|stop)/m)
      expect(block).not.toMatch(/launchctl (kickstart|bootout)[^\n]*hrc-server/)
    }
  })

  test('the lifecycle call no longer strips the caller identity', () => {
    expect(recipe).not.toContain('lifecycle_env')
    expect(recipe).not.toContain('-u HRC_SESSION_REF')
  })

  test('install happens in phase 1 and the identity assertion in phase 2', () => {
    expect(remoteBlocks[0]).toContain('just install no-sync=1')
    expect(remoteBlocks[1]).toContain('daemon is running ${deployed_sha}, expected ${target_sha}')
  })
})
