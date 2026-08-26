import { describe, expect, it } from 'bun:test'

import { shortenProjectId } from '../project-prefix'

describe('shortenProjectId', () => {
  it('uses curated prefixes for known projects', () => {
    expect(shortenProjectId('agent-control-plane')).toBe('acp')
    expect(shortenProjectId('agent-spaces')).toBe('asp')
    expect(shortenProjectId('hrc-runtime')).toBe('hrc')
    expect(shortenProjectId('agent-loop')).toBe('loop')
    expect(shortenProjectId('agents')).toBe('agents')
    expect(shortenProjectId('archagent')).toBe('arch')
    expect(shortenProjectId('media-ingest')).toBe('ingest')
    expect(shortenProjectId('safoundry')).toBe('safoundry')
    expect(shortenProjectId('taskboard')).toBe('taskboard')
    expect(shortenProjectId('wrkq')).toBe('wrkq')
  })

  it('derives a fallback for unknown hyphenated projects (initials)', () => {
    expect(shortenProjectId('voice-control')).toBe('vc')
    expect(shortenProjectId('scriptable-ghostty')).toBe('sg')
    expect(shortenProjectId('workflow-spec')).toBe('ws')
  })

  it('derives a fallback for unknown single-word projects (first 3)', () => {
    expect(shortenProjectId('knowledge')).toBe('kno')
  })

  it('derives a fallback for P-id projects', () => {
    expect(shortenProjectId('P-00223')).toBe('p223')
    expect(shortenProjectId('P-05')).toBe('p5')
  })

  it('returns empty string for an absent projectId', () => {
    expect(shortenProjectId(undefined)).toBe('')
    expect(shortenProjectId('')).toBe('')
  })
})
