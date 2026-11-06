import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProductionLifecycleOwner } from '../release-provenance.js'

// An atomic executable on private roots is still a fixture. Both roots and
// release provenance must agree; aliases must not hide a real owner.
test('lifecycle publication requires an atomic owner of both canonical roots', () => {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-owner-'))
  const runtime = join(home, 'praesidium/var/run/hrc')
  const state = join(home, 'praesidium/var/state/hrc')
  try {
    mkdirSync(runtime, { recursive: true })
    mkdirSync(state, { recursive: true })
    const input = { atomic: true, home, runtimeRoot: runtime, stateRoot: state }
    expect(isProductionLifecycleOwner(input)).toBe(true)
    expect(isProductionLifecycleOwner({ ...input, atomic: false })).toBe(false)
    expect(isProductionLifecycleOwner({ ...input, runtimeRoot: home })).toBe(false)
    expect(isProductionLifecycleOwner({ ...input, stateRoot: home })).toBe(false)
    expect(isProductionLifecycleOwner({ ...input, stateRoot: join(home, 'absent') })).toBe(false)
    const alias = join(home, 'alias')
    symlinkSync(runtime, alias)
    expect(isProductionLifecycleOwner({ ...input, runtimeRoot: alias })).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
