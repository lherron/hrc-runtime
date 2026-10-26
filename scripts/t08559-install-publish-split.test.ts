import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const justfile = readFileSync('justfile', 'utf8')

function recipeBody(name: string): string {
  const match = justfile.match(
    new RegExp(`^${name}(?=[ \\t:])[^\\n]*:\\n((?:[ \\t].*\\n|\\s*\\n)*)`, 'm')
  )
  expect(match, `justfile recipe ${name} must exist`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('T-08559 install and canonical publication boundary', () => {
  test('selects a local release from install and confines canonical registry writes to publish', () => {
    const install = recipeBody('install')
    expect(install).toContain('--publication-mode="$PRAESIDIUM_INSTALL_PUBLICATION_MODE"')
    expect(install).not.toContain('publish-local-verdaccio.ts')

    const publish = recipeBody('publish')
    expect(publish).toContain('_publish-selected-release')
    const selectedReleasePublisher = recipeBody('_publish-selected-release')
    expect(selectedReleasePublisher).toContain('args=(--selected-release)')
    expect(selectedReleasePublisher).toContain("1|'dry-run=1') args+=(--dry-run)")
    expect(recipeBody('deploy-max3')).toContain('"publish"')
    expect(recipeBody('deploy-svc')).toContain('"no-publish"')
    expect(recipeBody('deploy-hrcdev')).toContain('"no-publish"')
    // T-11930: the deploy lane publishes from its shared readback, after the
    // restart and the release identity assertion, and only from max3.
    const deployNode = recipeBody('_deploy-node')
    const readbackCall = deployNode.indexOf('just _node-readback')
    expect(readbackCall).toBeGreaterThan(deployNode.indexOf('hrc server restart --node'))
    expect(deployNode.slice(readbackCall)).toContain('"{{ publication }}"')
    const readback = recipeBody('_node-readback')
    const publishAt = readback.indexOf('just _publish-selected-release')
    expect(publishAt).toBeGreaterThan(
      readback.indexOf('daemon is running ${deployed_sha}, expected ${target_sha}')
    )
    expect(readback.slice(0, publishAt)).toContain(
      '[[ "$expected_node" == max3 ]] || fail \'only max3 may perform canonical HRC publication\''
    )
    expect(recipeBody('switch-owner-rusthrc')).toContain('"" no-publish')
    const fleet = recipeBody('deploy-fleet')
    expect(fleet).toContain('"max3" "max3" "$hrc_sha"')
    expect(fleet.indexOf('"max3" "max3" "$hrc_sha"')).toBeLessThan(
      fleet.indexOf('"mini" "svc" "$hrc_sha"')
    )
  })
})
