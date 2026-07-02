import { describe, expect, it } from 'bun:test'
import type { HrcTargetView } from 'hrc-core'

import { applyFilter } from './filter.js'
import type { HrcTopFilterRow, HrcTopFilterResult } from './filter.js'
import type { HrcTopPrimaryActionKind } from './action-policy.js'

/**
 * T-05406 Ph4 export contract for the pure filter seam:
 *
 * type HrcTopFilterRow = HrcTopVisibleRow-compatible row data that includes the
 * HrcTop row/target facts needed for text filtering:
 *   id, visibleTargetText/sessionRef, target.{sessionRef, scopeRef, laneRef,
 *   state, activeHostSessionId, runtime.runtimeId, continuation.provider/key},
 *   optional runtime.runtimeId, optional action kind text.
 *
 * applyFilter<T extends HrcTopFilterRow>(
 *   rows: readonly T[],
 *   query: string
 * ): HrcTopFilterResult<T>
 *
 * type HrcTopFilterResult<T> = {
 *   rows: readonly T[]       // stable-ordered visible row set for nav-state
 *   query: string            // trimmed operator query
 *   active: boolean          // false only for empty/blank query
 *   visibleRows: number      // footer numerator
 *   totalRows: number        // footer denominator
 * }
 *
 * These reds intentionally import ./filter.js before the module exists. The
 * first red bar should be a missing-module/missing-export failure; after the
 * module is added, the assertions below define the required behavior.
 */

type TestRow = HrcTopFilterRow & {
  id: string
  visibleTargetText: string
  target: HrcTargetView
  action: HrcTopPrimaryActionKind
}

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
    activeHostSessionId: 'hsid-cody-main',
    runtime: {
      runtimeId: 'rt-cody-main',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      operatorAttachable: true,
    },
    continuation: { provider: 'openai', key: 'conv-cody-main' },
    capabilities,
    ...overrides,
  }
}

function row(input: {
  id: string
  visibleTargetText: string
  agent: string
  project: string
  task: string
  lane: string
  state: HrcTargetView['state']
  action: HrcTopPrimaryActionKind
  runtimeId?: string | undefined
  hostSessionId?: string | undefined
  continuation?: { provider: string; key?: string | undefined } | undefined
}): TestRow {
  const sessionRef = `agent:${input.agent}:project:${input.project}:task:${input.task}/lane:${input.lane}`
  return {
    id: input.id,
    visibleTargetText: input.visibleTargetText,
    action: input.action,
    target: target({
      sessionRef,
      scopeRef: `agent:${input.agent}:project:${input.project}:task:${input.task}`,
      laneRef: input.lane,
      state: input.state,
      activeHostSessionId: input.hostSessionId,
      runtime: input.runtimeId
        ? {
            runtimeId: input.runtimeId,
            transport: 'tmux',
            status: 'ready',
            supportsLiteralSend: true,
            supportsCapture: true,
            operatorAttachable: true,
          }
        : undefined,
      continuation: input.continuation,
    }),
  }
}

function ids(result: HrcTopFilterResult<TestRow>): string[] {
  return result.rows.map((entry) => entry.id)
}

describe('hrc-top row filter', () => {
  it('hides non-matching rows instead of only moving the cursor', () => {
    const result = applyFilter(
      [
        row({
          id: 'cody-row',
          visibleTargetText: 'cody@hrc-runtime:T-05406',
          agent: 'cody',
          project: 'hrc-runtime',
          task: 'T-05406',
          lane: 'main',
          state: 'bound',
          action: 'attach',
          runtimeId: 'rt-filter-cody',
        }),
        row({
          id: 'clod-row',
          visibleTargetText: 'clod@agent-spaces:T-05499',
          agent: 'clod',
          project: 'agent-spaces',
          task: 'T-05499',
          lane: 'repair',
          state: 'dormant',
          action: 'resume',
          runtimeId: 'rt-filter-clod',
        }),
      ],
      'cody'
    )

    expect(ids(result)).toEqual(['cody-row'])
    expect(result).toMatchObject({
      query: 'cody',
      active: true,
      visibleRows: 1,
      totalRows: 2,
    })
  })

  it('matches case-insensitively across every text field promised by the spec', () => {
    const rows = [
      row({
        id: 'visible-target',
        visibleTargetText: 'Daedalus@Architecture:T-05402',
        agent: 'daedalus',
        project: 'architecture',
        task: 'T-05402',
        lane: 'main',
        state: 'bound',
        action: 'focus',
      }),
      row({
        id: 'agent-project-task-lane-state-action',
        visibleTargetText: 'display label',
        agent: 'SMOKEY',
        project: 'HRC-RUNTIME',
        task: 'T-05406',
        lane: 'REPAIR',
        state: 'dormant',
        action: 'resume',
      }),
      row({
        id: 'runtime-host',
        visibleTargetText: 'runtime details',
        agent: 'cody',
        project: 'agent-spaces',
        task: 'primary',
        lane: 'main',
        state: 'bound',
        action: 'attach',
        runtimeId: 'RT-FILTER-CASE',
        hostSessionId: 'HSID-FILTER-CASE',
      }),
      row({
        id: 'continuation',
        visibleTargetText: 'continuation details',
        agent: 'clod',
        project: 'wrkq',
        task: 'primary',
        lane: 'main',
        state: 'dormant',
        action: 'resume',
        continuation: { provider: 'OPENAI', key: 'CONV-FILTER-CASE' },
      }),
    ]

    expect(ids(applyFilter(rows, 'daedalus'))).toEqual(['visible-target'])
    expect(ids(applyFilter(rows, 'smokey'))).toEqual(['agent-project-task-lane-state-action'])
    expect(ids(applyFilter(rows, 'hrc-runtime'))).toEqual(['agent-project-task-lane-state-action'])
    expect(ids(applyFilter(rows, 't-05406'))).toEqual(['agent-project-task-lane-state-action'])
    expect(ids(applyFilter(rows, 'repair'))).toEqual(['agent-project-task-lane-state-action'])
    expect(ids(applyFilter(rows, 'DORMANT'))).toEqual([
      'agent-project-task-lane-state-action',
      'continuation',
    ])
    expect(ids(applyFilter(rows, 'resume'))).toEqual([
      'agent-project-task-lane-state-action',
      'continuation',
    ])
    expect(ids(applyFilter(rows, 'rt-filter-case'))).toEqual(['runtime-host'])
    expect(ids(applyFilter(rows, 'hsid-filter-case'))).toEqual(['runtime-host'])
    expect(ids(applyFilter(rows, 'openai'))).toEqual(['continuation'])
    expect(ids(applyFilter(rows, 'conv-filter-case'))).toEqual(['continuation'])
  })

  it('ANDs space-separated terms and keeps stable source order', () => {
    const rows = [
      row({
        id: 'only-wrkq',
        visibleTargetText: 'wrkq monitor',
        agent: 'clod',
        project: 'wrkq',
        task: 'T-05406',
        lane: 'main',
        state: 'bound',
        action: 'attach',
      }),
      row({
        id: 'wrkq-cody-first',
        visibleTargetText: 'cody@wrkq:T-05406',
        agent: 'cody',
        project: 'wrkq',
        task: 'T-05406',
        lane: 'main',
        state: 'bound',
        action: 'attach',
      }),
      row({
        id: 'only-cody',
        visibleTargetText: 'cody@agent-spaces:T-05406',
        agent: 'cody',
        project: 'agent-spaces',
        task: 'T-05406',
        lane: 'main',
        state: 'bound',
        action: 'attach',
      }),
      row({
        id: 'wrkq-cody-second',
        visibleTargetText: 'cody@wrkq:T-05407',
        agent: 'cody',
        project: 'wrkq',
        task: 'T-05407',
        lane: 'main',
        state: 'busy',
        action: 'focus',
      }),
    ]

    expect(ids(applyFilter(rows, '  wrkq   cody  '))).toEqual([
      'wrkq-cody-first',
      'wrkq-cody-second',
    ])
  })

  it('treats an empty or blank query as inactive and restores all rows', () => {
    const rows = [
      row({
        id: 'first',
        visibleTargetText: 'first target',
        agent: 'cody',
        project: 'hrc-runtime',
        task: 'T-05406',
        lane: 'main',
        state: 'bound',
        action: 'attach',
      }),
      row({
        id: 'second',
        visibleTargetText: 'second target',
        agent: 'clod',
        project: 'agent-spaces',
        task: 'T-05499',
        lane: 'repair',
        state: 'dormant',
        action: 'resume',
      }),
    ]

    expect(applyFilter(rows, '')).toMatchObject({
      rows,
      query: '',
      active: false,
      visibleRows: 2,
      totalRows: 2,
    })
    expect(applyFilter(rows, '   \t  ')).toMatchObject({
      rows,
      query: '',
      active: false,
      visibleRows: 2,
      totalRows: 2,
    })
  })
})
