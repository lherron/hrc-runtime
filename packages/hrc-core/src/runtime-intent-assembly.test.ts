/**
 * T-08597 — intent assembly from OBSERVED declaration facts.
 *
 * Profile/targets parsing moved aspd-side; these pin the pure HRC assembly:
 * interaction semantics pass-through, deny-list stripping, scalar filtering,
 * the harness-id allowlist, the directive-overlay compat rule, and the
 * stripped-provisioning warning text (T-08128 byte contract).
 */
import { describe, expect, test } from 'bun:test'

import { HrcDomainError } from './errors.js'
import {
  applyProvisionDirectives,
  assembleHrcRuntimeIntent,
  buildInvalidProfileWarning,
  formatProfileProvisioningStrippedWarning,
  harnessFrontendToHrcHarness,
} from './runtime-intent-assembly.js'

function observed(harness: string, provider: 'anthropic' | 'openai' = 'anthropic') {
  return {
    provisioning: {
      provider,
      frontend: harness,
      effectiveHarness: harness,
      scalars: { harness, model: 'sonnet' },
    },
    placement: {
      agentRoot: '/agents/fixture-agent',
      projectRoot: '/repo' as string | undefined,
      cwd: '/repo',
      runMode: 'task' as const,
      bundle: { kind: 'agent-project' as const, agentName: 'fixture-agent', projectRoot: '/repo' },
    },
  }
}

describe('assembleHrcRuntimeIntent — observed facts plus caller semantics', () => {
  test('codex observation → openai + codex-cli harness id', () => {
    const intent = assembleHrcRuntimeIntent(observed('codex-cli', 'openai'), {
      interactive: false,
      preferredMode: 'headless',
    })
    expect(intent.harness).toMatchObject({
      provider: 'openai',
      id: 'codex-cli',
      interactive: false,
    })
    expect(intent.execution).toEqual({ preferredMode: 'headless' })
    expect(intent.placement).toMatchObject({
      agentRoot: '/agents/fixture-agent',
      cwd: '/repo',
      runMode: 'task',
    })
  })

  test('caller-supplied interaction semantics pass through; only provider/harness observe', () => {
    const intent = assembleHrcRuntimeIntent(observed('codex-cli', 'openai'), {
      interactive: false,
      preferredMode: 'nonInteractive',
    })
    expect(intent.execution).toEqual({ preferredMode: 'nonInteractive' })
    expect(intent.harness.interactive).toBe(false)
  })

  test('T-05177: allowInteractiveSurfaceReuse threads into execution only when supplied', () => {
    const off = assembleHrcRuntimeIntent(observed('claude-code'), {
      interactive: false,
      preferredMode: 'headless',
      allowInteractiveSurfaceReuse: false,
    })
    expect(off.execution).toEqual({
      preferredMode: 'headless',
      allowInteractiveSurfaceReuse: false,
    })

    const omitted = assembleHrcRuntimeIntent(observed('claude-code'), {
      interactive: false,
      preferredMode: 'headless',
    })
    expect(omitted.execution).toEqual({ preferredMode: 'headless' })
  })

  test('deny-listed and non-scalar provisioning never rides the intent', () => {
    const intent = assembleHrcRuntimeIntent(
      {
        provisioning: {
          provider: 'anthropic',
          frontend: 'claude-code',
          effectiveHarness: 'claude',
          scalars: { harness: 'claude-code', model: 'opus' },
        },
        placement: {
          agentRoot: '/agents/a',
          cwd: '/agents/a',
          runMode: 'task',
          bundle: { kind: 'agent-project', agentName: 'a' },
        },
      },
      { interactive: true, preferredMode: 'interactive' }
    )
    expect(intent.provision).toMatchObject({ harness: 'claude-code', model: 'opus' })
    expect(intent.harness).toMatchObject({ provider: 'anthropic', id: 'claude-code' })
  })

  test('unadmitted frontend carries no id; HRC picks its default downstream', () => {
    const intent = assembleHrcRuntimeIntent(observed('agent-harness-tui'), {
      interactive: false,
      preferredMode: 'headless',
    })
    expect(intent.harness).toMatchObject({ provider: 'anthropic', interactive: false })
    expect(intent.harness).not.toHaveProperty('id')
  })
})

describe('harnessFrontendToHrcHarness — frontend allowlist (T-08597 narrowing)', () => {
  test.each([
    ['agent-sdk', 'agent-sdk'],
    ['claude-code', 'claude-code'],
    ['codex-cli', 'codex-cli'],
    ['pi-cli', 'pi-cli'],
    ['pi-sdk', 'pi-sdk'],
    ['muse-cli', 'muse-cli'],
  ] as const)('passes %s through', (frontend, id) => {
    expect(harnessFrontendToHrcHarness(frontend)).toBe(id)
  })

  test('bare catalog ids no longer normalize — observations are always frontend form', () => {
    expect(harnessFrontendToHrcHarness('codex')).toBeUndefined()
    expect(harnessFrontendToHrcHarness('pi')).toBeUndefined()
    expect(harnessFrontendToHrcHarness('claude')).toBeUndefined()
    expect(harnessFrontendToHrcHarness(undefined)).toBeUndefined()
    expect(harnessFrontendToHrcHarness('not-a-harness')).toBeUndefined()
  })
})

describe('applyProvisionDirectives — compat overlay', () => {
  const merged = {
    provider: 'anthropic' as const,
    harness: 'claude-code',
    provision: { harness: 'claude-code', model: 'opus' },
  }

  test('directives overlay scalars without moving provider or harness id', () => {
    const overlaid = applyProvisionDirectives(merged, { model: 'sonnet', node: 'svc' })
    expect(overlaid.provision).toMatchObject({
      harness: 'claude-code',
      model: 'sonnet',
      node: 'svc',
    })
    expect(overlaid.provider).toBe('anthropic')
    expect(overlaid.harnessId).toBe('claude-code')
  })

  test('a directive that changes the harness throws toward the daemon route', () => {
    expect(() => applyProvisionDirectives(merged, { harness: 'codex' })).toThrow(HrcDomainError)
    expect(() => applyProvisionDirectives(merged, { harness: 'codex' })).toThrow(
      /POST \/v1\/declarations\/resolve/
    )
  })
})

describe('stripped-provisioning warning text (T-08128 byte contract)', () => {
  test('names agent, path, consequence, and error on one line', () => {
    const line = buildInvalidProfileWarning({
      agentId: 'slugger',
      agentRoot: '/agents/slugger',
      diagnosticMessages: ['TOML parse error at line 3\nunexpected end'],
      survivingProvisionKeys: [],
    })
    expect(line).toContain('agent.provisioning.stripped')
    expect(line).toContain('slugger')
    expect(line).toContain('/agents/slugger/agent-profile.toml')
    expect(line).toContain('NO provisioning')
    expect(line).toContain('no model pin')
    expect(line).toMatch(/error=\S/)
    expect(line).toContain('TOML')
    expect(line).not.toContain('\n')
  })

  test('a surviving target pin reports what survived, not a blanket nothing', () => {
    const line = buildInvalidProfileWarning({
      agentId: 'slugger',
      agentRoot: '/agents/slugger',
      diagnosticMessages: ['broken'],
      survivingProvisionKeys: ['node'],
    })
    expect(line).toContain('WITHOUT')
    expect(line).toContain('node')
    expect(line).not.toContain('NO provisioning at all')
  })

  test('formatProfileProvisioningStrippedWarning collapses multi-line errors', () => {
    const line = formatProfileProvisioningStrippedWarning({
      agentId: 'slugger',
      profilePath: '/agents/slugger/agent-profile.toml',
      errorMessage: 'line one\nline two',
      survivingProvisionKeys: [],
    })
    expect(line).not.toContain('\n')
  })
})
