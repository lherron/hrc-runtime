import { describe, expect, test } from 'bun:test'

import { parseMonitorSelectors, scopeMatchesSelectorSpec } from '../selector-shape.js'

describe('monitor task selectors', () => {
  test('a subtask id is a task selector that watches only the subtask seat', async () => {
    const [spec] = await parseMonitorSelectors(['T-12345.render-preview'])
    expect(spec).toEqual({
      kind: 'task',
      raw: 'T-12345.render-preview',
      taskId: 'T-12345.render-preview',
    })
    if (spec === undefined) throw new Error('no spec')
    expect(scopeMatchesSelectorSpec('agent:a:project:p:task:T-12345.render-preview', spec)).toBe(
      true
    )
    expect(scopeMatchesSelectorSpec('agent:a:project:p:task:T-12345', spec)).toBe(false)
  })

  test('the owner selector does not silently match a subtask seat', async () => {
    const [spec] = await parseMonitorSelectors(['T-12345'])
    if (spec === undefined) throw new Error('no spec')
    expect(spec.kind).toBe('task')
    expect(scopeMatchesSelectorSpec('agent:a:project:p:task:T-12345.render-preview', spec)).toBe(
      false
    )
  })
})
