import { describe, expect, it } from 'bun:test'
import type { HrcRuntimeIntent } from 'hrc-core'

import { assertV2SelectionCompatibleForReuse } from '../runtime-select.js'

const realizedRuntime = {
  runtimeId: 'runtime-v2',
  runtimeStateJson: {
    selection: {
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      presentation: false,
      provenance: {
        harness: 'catalog-default',
        modelProvider: 'agent-profile',
        model: 'agent-profile',
        reasoningEffort: 'project-target',
        presentation: 'catalog-default',
      },
    },
  },
}

describe('v2 selection reuse', () => {
  it('treats omission as reuse of the established realized execution', () => {
    expect(() =>
      assertV2SelectionCompatibleForReuse(realizedRuntime, { selection: {} } as HrcRuntimeIntent)
    ).not.toThrow()
  })

  it('refuses an explicit mismatch rather than selecting a replacement runtime', () => {
    expect(() =>
      assertV2SelectionCompatibleForReuse(realizedRuntime, {
        selection: { presentation: true },
      } as HrcRuntimeIntent)
    ).toThrow('explicit v2 selection does not match the established runtime')
  })

  it('refuses an explicit selection against a legacy runtime with no realized v2 identity', () => {
    expect(() =>
      assertV2SelectionCompatibleForReuse({ runtimeId: 'runtime-v1', runtimeStateJson: {} }, {
        selection: { harness: 'agent-harness' },
      } as HrcRuntimeIntent)
    ).toThrow('cannot compare it to a legacy runtime')
  })

  it('does not silently reuse when raw summon directives require a new producer realization', () => {
    expect(() =>
      assertV2SelectionCompatibleForReuse(realizedRuntime, {
        summonDirectives: { model_provider: 'openai-codex' },
      } as HrcRuntimeIntent)
    ).toThrow('raw summon directives require producer realization')
  })

  it('treats an empty raw summon-directive object as omission', () => {
    expect(() =>
      assertV2SelectionCompatibleForReuse(realizedRuntime, {
        summonDirectives: {},
      } as HrcRuntimeIntent)
    ).not.toThrow()
  })
})
