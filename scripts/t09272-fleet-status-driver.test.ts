import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const justfile = readFileSync('justfile', 'utf8')

function recipeBody(name: string): string {
  const match = justfile.match(
    new RegExp(`^${name}(?=[ \\t:])[^\\n]*:\\n((?:[ \\t].*\\n|\\s*\\n)*)`, 'm')
  )
  expect(match, `Justfile recipe ${name} must exist`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('T-09272 fleet-status driver selection', () => {
  test('uses the local probe for max3 only when the local daemon identifies as max3', () => {
    const fleetStatus = recipeBody('fleet-status')

    expect(fleetStatus).toContain('run_on_node()')
    expect(fleetStatus).toContain('if [[ "$label" == max3 && "$local_node" == max3 ]]')
    expect(fleetStatus).toContain('ssh -o BatchMode=yes -o ConnectTimeout=8 "$target"')
    expect(fleetStatus).toContain("probe max3 'max3'")
    expect(fleetStatus).toContain("tools max3 'max3'")
    expect(fleetStatus).toContain("layout max3 'max3'")
    expect(fleetStatus).not.toContain("probe max3 ''")
  })

  test('rejects a status row whose reported node identity differs from its label', () => {
    const fleetStatus = recipeBody('fleet-status')

    expect(fleetStatus).toContain("actual_node=\"$(jq -r '.node.nodeId // \"unknown\"' <<<\"$status\")\"")
    expect(fleetStatus).toContain('if [[ "$actual_node" != "$label" ]]')
    expect(fleetStatus).toContain('"wrong-driver:$actual_node"')
  })
})
