import { describe, expect, it } from 'bun:test'
import type { HrcTargetView } from 'hrc-core'

import { interpretHrcTopKey } from './keymap.js'
import { createNavState, reduceNavState } from './nav-state.js'
import { buildReadModel } from './read-model.js'
import { buildTopScreenModel, renderTopScreen, selectFilteredVisibleRows } from './render.js'

const capabilities: HrcTargetView['capabilities'] = {
  state: 'bound',
  modesSupported: ['headless'],
  defaultMode: 'headless',
  dmReady: true,
  sendReady: true,
  peekReady: true,
}

function target(overrides: Partial<HrcTargetView> = {}): HrcTargetView {
  return {
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-05406/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05406',
    laneRef: 'main',
    state: 'bound',
    activeHostSessionId: 'hsid-1',
    runtime: {
      runtimeId: 'rt-1',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      operatorAttachable: true,
      lastActivityAt: '2026-07-02T12:00:00.000Z',
    },
    capabilities,
    ...overrides,
  }
}

function sampleModel() {
  return buildReadModel(
    [
      target(),
      target({
        sessionRef: 'agent:clod:project:agent-spaces:task:T-05499/lane:repair',
        scopeRef: 'agent:clod:project:agent-spaces:task:T-05499',
        laneRef: 'repair',
        state: 'dormant',
        activeHostSessionId: undefined,
        runtime: undefined,
        continuation: { provider: 'openai', key: 'conv-clod' },
      }),
      target({
        sessionRef: 'agent:smokey:project:wrkq:task:T-05407/lane:main',
        scopeRef: 'agent:smokey:project:wrkq:task:T-05407',
        laneRef: 'main',
        state: 'busy',
        activeHostSessionId: 'hsid-3',
        runtime: {
          runtimeId: 'rt-3',
          transport: 'tmux',
          status: 'ready',
          supportsLiteralSend: true,
          supportsCapture: true,
          operatorAttachable: true,
        },
      }),
    ],
    new Date('2026-07-02T12:05:00.000Z')
  )
}

describe('hrc-top filter wiring', () => {
  it('narrows the rendered rows and footer counts to the filtered set', () => {
    const model = sampleModel()
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 20 })
    const screen = buildTopScreenModel({
      model,
      navState,
      viewportHeight: 20,
      width: 90,
      filterText: 'clod',
    })

    expect(screen.rows.map((row) => row.handle)).toEqual(['clod@agent-spaces:T-05499~repair'])
    expect(screen.visibleRows).toBe(1)
    expect(screen.totalRows).toBe(3)
    expect(screen.filterActive).toBe(true)
  })

  it('renders the footer filter line with visible/total counts', () => {
    const model = sampleModel()
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 20 })
    const output = renderTopScreen({
      model,
      navState,
      viewportHeight: 20,
      width: 90,
      filterText: 'wrkq',
    })

    expect(output).toContain('filter: wrkq   rows: 1/3')
    expect(output).toContain('smokey@wrkq:T-05407')
    expect(output).not.toContain('cody@hrc-runtime')
  })

  it('shows a filter-entry indicator when actively typing', () => {
    const model = sampleModel()
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 20 })
    const output = renderTopScreen({
      model,
      navState,
      viewportHeight: 20,
      width: 90,
      filterText: 'cod',
      filterMode: true,
    })

    expect(output).toContain('/cod')
  })

  it('restores all rows and reports the filter as inactive for a blank query', () => {
    const model = sampleModel()
    const navState = createNavState({ visibleRows: model.rows, viewportHeight: 20 })
    // showAll so the idle tail is not collapsed and every row is present.
    const screen = buildTopScreenModel({
      model,
      navState,
      viewportHeight: 20,
      width: 90,
      filterText: '   ',
      showAll: true,
    })

    expect(screen.rows).toHaveLength(3)
    expect(screen.visibleRows).toBe(3)
    expect(screen.totalRows).toBe(3)
    expect(screen.filterActive).toBe(false)
  })

  it('keeps navigation inside the filtered set (j/k respect filtered rows)', () => {
    const model = sampleModel()
    const filtered = selectFilteredVisibleRows(model, 'main')
    // Only cody@hrc-runtime and smokey@wrkq have lane:main.
    expect(filtered.map((row) => row.id)).toEqual(['rt-1', 'rt-3'])

    let navState = createNavState({ visibleRows: filtered, viewportHeight: 20 })
    expect(navState.selectedRowId).toBe('rt-1')

    navState = reduceNavState(
      navState,
      { type: 'key', key: 'j' },
      {
        visibleRows: filtered,
        viewportHeight: 20,
      }
    )
    expect(navState.selectedRowId).toBe('rt-3')

    // G cannot escape the filtered set.
    navState = reduceNavState(
      navState,
      { type: 'key', key: 'G' },
      {
        visibleRows: filtered,
        viewportHeight: 20,
      }
    )
    expect(navState.selectedRowId).toBe('rt-3')
  })

  it('preserves selection identity when the filter set is replaced', () => {
    const model = sampleModel()
    const all = selectFilteredVisibleRows(model, '')
    let navState = createNavState({ visibleRows: all, viewportHeight: 20 })
    navState = reduceNavState(
      navState,
      { type: 'key', key: 'G' },
      {
        visibleRows: all,
        viewportHeight: 20,
      }
    )
    expect(navState.selectedRowId).toBe('rt-3')

    // Applying a filter that still contains the selection keeps it selected.
    const filtered = selectFilteredVisibleRows(model, 'wrkq')
    navState = reduceNavState(
      navState,
      { type: 'refresh' },
      {
        visibleRows: filtered,
        viewportHeight: 20,
      }
    )
    expect(navState.selectedRowId).toBe('rt-3')
  })

  it('maps / n and N to filter and search intents', () => {
    expect(interpretHrcTopKey('/')).toEqual({ intent: { type: 'filter' } })
    expect(interpretHrcTopKey('n')).toEqual({ intent: { type: 'searchNext' } })
    expect(interpretHrcTopKey('N')).toEqual({ intent: { type: 'searchPrev' } })
  })
})
