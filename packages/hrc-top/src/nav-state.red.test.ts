import { describe, expect, it } from 'bun:test'

import { createNavState, reduceNavState } from './nav-state.js'
import type { HrcTopNavState, HrcTopVisibleRow } from './nav-state.js'

/**
 * T-05405 Ph3 export contract for the pure navigation seam:
 *
 * type HrcTopVisibleRow = { id: string }
 * type HrcTopNavState = {
 *   selectedRowId: string | undefined
 *   selectedIndex: number
 *   marks: Readonly<Record<string, string>>
 * }
 *
 * createNavState(input: {
 *   visibleRows: readonly HrcTopVisibleRow[]
 *   viewportHeight: number
 *   selectedRowId?: string
 * }): HrcTopNavState
 *
 * reduceNavState(
 *   state: HrcTopNavState,
 *   action:
 *     | { type: 'key'; key: 'j' | 'k' | 'gg' | 'G' | 'ctrl-d' | 'ctrl-u' | 'ctrl-f' | 'ctrl-b' }
 *     | { type: 'mark'; name: string }
 *     | { type: 'jumpToMark'; name: string }
 *     | { type: 'refresh' },
 *   context: { visibleRows: readonly HrcTopVisibleRow[]; viewportHeight: number }
 * ): HrcTopNavState
 *
 * Rows are an abstract ordered visible-row set supplied by the caller. The
 * reducer must preserve selection and marks by stable row id so Ph4 can swap
 * filtered row sets without rewriting movement.
 */

function rows(ids: readonly string[]): HrcTopVisibleRow[] {
  return ids.map((id) => ({ id }))
}

function selected(state: HrcTopNavState): string | undefined {
  return state.selectedRowId
}

describe('hrc-top navigation state over an abstract visible-row set', () => {
  it('moves with vi keys and clamps at visible-row boundaries', () => {
    const visibleRows = rows(['row-a', 'row-b', 'row-c', 'row-d', 'row-e', 'row-f'])
    let state = createNavState({ visibleRows, viewportHeight: 4 })

    expect(selected(state)).toBe('row-a')

    state = reduceNavState(state, { type: 'key', key: 'k' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-a')

    state = reduceNavState(state, { type: 'key', key: 'j' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-b')

    state = reduceNavState(state, { type: 'key', key: 'G' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-f')

    state = reduceNavState(state, { type: 'key', key: 'j' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-f')

    state = reduceNavState(state, { type: 'key', key: 'gg' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-a')
  })

  it('uses the supplied viewport height for half-page and page movement', () => {
    const visibleRows = rows(['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6'])
    let state = createNavState({ visibleRows, viewportHeight: 4, selectedRowId: 'row-1' })

    state = reduceNavState(state, { type: 'key', key: 'ctrl-d' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-3')

    state = reduceNavState(state, { type: 'key', key: 'ctrl-f' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-6')

    state = reduceNavState(state, { type: 'key', key: 'ctrl-u' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-4')

    state = reduceNavState(state, { type: 'key', key: 'ctrl-b' }, { visibleRows, viewportHeight: 4 })
    expect(selected(state)).toBe('row-0')
  })

  it('stores marks by stable row identity and jumps to the marked row after reorder', () => {
    const initialRows = rows(['agent-a', 'agent-b', 'agent-c'])
    const reorderedRows = rows(['agent-c', 'agent-a', 'agent-b'])
    let state = createNavState({ visibleRows: initialRows, viewportHeight: 3, selectedRowId: 'agent-b' })

    state = reduceNavState(state, { type: 'mark', name: 'x' }, { visibleRows: initialRows, viewportHeight: 3 })
    state = reduceNavState(state, { type: 'key', key: 'G' }, { visibleRows: reorderedRows, viewportHeight: 3 })
    expect(selected(state)).toBe('agent-b')

    state = reduceNavState(state, { type: 'key', key: 'gg' }, { visibleRows: reorderedRows, viewportHeight: 3 })
    expect(selected(state)).toBe('agent-c')

    state = reduceNavState(state, { type: 'jumpToMark', name: 'x' }, { visibleRows: reorderedRows, viewportHeight: 3 })
    expect(selected(state)).toBe('agent-b')
    expect(state.selectedIndex).toBe(2)
  })

  it('preserves selection across visible-row replacement and falls back to the nearest surviving row', () => {
    const allRows = rows(['row-a', 'row-b', 'row-c', 'row-d', 'row-e'])
    let state = createNavState({ visibleRows: allRows, viewportHeight: 5, selectedRowId: 'row-c' })

    const reorderedRows = rows(['row-e', 'row-c', 'row-a'])
    state = reduceNavState(state, { type: 'refresh' }, { visibleRows: reorderedRows, viewportHeight: 5 })
    expect(selected(state)).toBe('row-c')

    state = createNavState({ visibleRows: allRows, viewportHeight: 5, selectedRowId: 'row-c' })
    const filteredRows = rows(['row-a', 'row-d', 'row-e'])
    state = reduceNavState(state, { type: 'refresh' }, { visibleRows: filteredRows, viewportHeight: 5 })
    expect(selected(state)).toBe('row-d')
  })
})
