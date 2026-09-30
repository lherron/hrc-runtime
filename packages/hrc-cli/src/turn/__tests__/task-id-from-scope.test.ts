import { describe, expect, test } from 'bun:test'

import { taskIdFromScope } from '../taskId.js'

describe('taskIdFromScope', () => {
  test('reports the subtask id for a subtask scope, not its owner', () => {
    expect(taskIdFromScope('agent:clod:project:hrc-runtime:task:T-12345.render-preview')).toBe(
      'T-12345.render-preview'
    )
    expect(taskIdFromScope('clod@hrc-runtime:T-12345.render-preview')).toBe(
      'T-12345.render-preview'
    )
    expect(taskIdFromScope('agent:clod:project:p:task:T-12345.slug/lane:main')).toBe('T-12345.slug')
  })

  test('ordinary and non-subtask shapes keep their owner reading', () => {
    expect(taskIdFromScope('agent:larry:project:agent-spaces:task:T-01449')).toBe('T-01449')
    expect(taskIdFromScope('agent:x:project:p:task:T-08199:role:parallel-alpha')).toBe('T-08199')
    expect(taskIdFromScope('agent:x:project:p:task:T-12345.2')).toBe('T-12345')
    expect(taskIdFromScope('agent:x:project:p:task:T-12345.a.b')).toBe('T-12345')
    expect(taskIdFromScope('agent:x:project:p:task:T-12345.slug-')).toBe('T-12345')
    expect(taskIdFromScope('agent:x:project:p:task:T-08199-e2e')).toBe('T-08199')
    expect(taskIdFromScope('agent:x:project:p:task:primary')).toBeUndefined()
  })
})
