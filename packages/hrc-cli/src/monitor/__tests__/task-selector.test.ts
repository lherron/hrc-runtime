import { describe, expect, test } from 'bun:test'
import type { HrcMonitorEvent, HrcMonitorState } from 'hrc-core'

import {
  eventMatchesSelectorSet,
  parseMonitorSelectors,
  scopeMatchesSelectorSpec,
  selectorConditionCandidates,
} from '../selector-shape.js'

const EVENTS = { includeSubtasks: true }
const STATE = { includeSubtasks: false }

const OWNER = 'agent:a:project:p:task:T-12345'
const SUBTASK = 'agent:a:project:p:task:T-12345.render-preview'
const LONGER = 'agent:a:project:p:task:T-123456'

function fixtureIdentity(scopeRef: string) {
  return {
    kind: 'project-task' as const,
    agentId: 'a',
    projectId: 'p',
    taskId: scopeRef.split(':task:')[1]?.split(':')[0],
  }
}

const state: HrcMonitorState = {
  sessions: [OWNER, SUBTASK, LONGER].map((scopeRef, index) => ({
    sessionRef: `${scopeRef}/lane:main`,
    scopeRef,
    identity: fixtureIdentity(scopeRef),
    laneRef: 'main',
    hostSessionId: `host-${index}`,
    generation: 1,
    runtimeId: `rt-${index}`,
  })) as HrcMonitorState['sessions'],
  runtimes: [],
  events: [],
}

function event(scopeRef: string): HrcMonitorEvent {
  return { seq: 1, event: 'turn.finished', scopeRef, identity: fixtureIdentity(scopeRef) }
}

describe('monitor task selectors', () => {
  test('a subtask id is a task selector that watches only the subtask seat', async () => {
    const [spec] = await parseMonitorSelectors(['T-12345.render-preview'])
    expect(spec).toEqual({
      kind: 'task',
      raw: 'T-12345.render-preview',
      taskId: 'T-12345.render-preview',
    })
    if (spec === undefined) throw new Error('no spec')
    expect(scopeMatchesSelectorSpec(SUBTASK, spec, EVENTS, fixtureIdentity(SUBTASK))).toBe(true)
    expect(
      scopeMatchesSelectorSpec(
        `${SUBTASK}:role:tester`,
        spec,
        EVENTS,
        fixtureIdentity(`${SUBTASK}:role:tester`)
      )
    ).toBe(true)
    expect(scopeMatchesSelectorSpec(OWNER, spec, EVENTS, fixtureIdentity(OWNER))).toBe(false)
    expect(
      scopeMatchesSelectorSpec(`${OWNER}.render`, spec, EVENTS, fixtureIdentity(`${OWNER}.render`))
    ).toBe(false)
  })

  // T-09902, named subtasks *Events*: a task selector covers its subtasks.
  test('the owner selector shows its subtask seats in event views', async () => {
    const specs = await parseMonitorSelectors(['T-12345'])
    const shown = [OWNER, SUBTASK, `${SUBTASK}:role:tester`, LONGER].filter((scopeRef) =>
      eventMatchesSelectorSet(state, event(scopeRef), specs, EVENTS)
    )
    expect(shown).toEqual([OWNER, SUBTASK, `${SUBTASK}:role:tester`])
  })

  test('T-1234 does not match T-12345 or its subtasks', async () => {
    const [spec] = await parseMonitorSelectors(['T-1234'])
    if (spec === undefined) throw new Error('no spec')
    expect(scopeMatchesSelectorSpec(OWNER, spec, EVENTS, fixtureIdentity(OWNER))).toBe(false)
    expect(scopeMatchesSelectorSpec(SUBTASK, spec, EVENTS, fixtureIdentity(SUBTASK))).toBe(false)
  })

  test('an owner wait never sees a subtask edge or subtask state', async () => {
    const specs = await parseMonitorSelectors(['T-12345'])
    expect(eventMatchesSelectorSet(state, event(SUBTASK), specs, STATE)).toBe(false)
    expect(selectorConditionCandidates(state, specs).map((c) => c.scopeRef)).toEqual([OWNER])
  })
})
