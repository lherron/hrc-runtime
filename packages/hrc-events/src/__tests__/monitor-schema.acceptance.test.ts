import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as HrcEvents from '../index.js'

const expectedMonitorResults = [
  'turn_succeeded',
  'turn_failed',
  'runtime_dead',
  'runtime_crashed',
  'response',
  'idle_no_response',
  'already_idle',
  'already_busy',
  'no_active_turn',
  'context_changed',
  'timeout',
  'stalled',
  'monitor_error',
] as const

const expectedFailureKinds = [
  'model',
  'tool',
  'process',
  'runtime',
  'cancelled',
  'unknown',
] as const

const expectedContextChangedReasons = ['session_rebound', 'generation_changed', 'cleared'] as const

const requiredMonitorEventNames = [
  'monitor.snapshot',
  'turn.started',
  'turn.finished',
  'runtime.idle',
  'runtime.busy',
  'runtime.crashed',
  'runtime.dead',
  'message.response',
  'monitor.completed',
  'monitor.stalled',
] as const

function exportedValues(name: keyof typeof HrcEvents): string[] {
  const value = HrcEvents[name]

  if (Array.isArray(value)) return [...value].sort()

  if (value && typeof value === 'object') {
    const candidate = value as {
      options?: unknown
      enum?: Record<string, unknown>
      _def?: { values?: unknown }
    }

    if (Array.isArray(candidate.options)) return [...candidate.options].sort()
    if (candidate.enum && typeof candidate.enum === 'object') {
      return Object.values(candidate.enum)
        .filter((item): item is string => typeof item === 'string')
        .sort()
    }
    if (Array.isArray(candidate._def?.values)) return [...candidate._def.values].sort()

    return Object.values(value)
      .filter((item): item is string => typeof item === 'string')
      .sort()
  }

  return []
}

describe('monitor schema acceptance', () => {
  it('keeps MonitorResult stable', () => {
    expect(exportedValues('MonitorResult' as keyof typeof HrcEvents)).toEqual(
      [...expectedMonitorResults].sort()
    )
  })

  it('keeps MonitorFailureKind stable', () => {
    expect(exportedValues('MonitorFailureKind' as keyof typeof HrcEvents)).toEqual(
      [...expectedFailureKinds].sort()
    )
  })

  it('keeps ContextChangedReason stable', () => {
    expect(exportedValues('ContextChangedReason' as keyof typeof HrcEvents)).toEqual(
      [...expectedContextChangedReasons].sort()
    )
  })

  it('covers the stable monitor event names', () => {
    expect(exportedValues('MonitorEventName' as keyof typeof HrcEvents)).toEqual(
      expect.arrayContaining(requiredMonitorEventNames)
    )
  })

  it('validates monitor event payload shape', () => {
    const schema = HrcEvents.MonitorEventSchema as {
      safeParse?: (input: unknown) => { success: boolean }
    }

    expect(schema?.safeParse).toBeTypeOf('function')

    const validEvent = {
      event: 'monitor.completed',
      selector: 'cody@agent-spaces:T-01287',
      runtimeId: 'runtime-1',
      turnId: 'turn-1',
      result: 'turn_failed',
      failureKind: 'tool',
      reason: 'generation_changed',
      replayed: false,
      exitCode: 1,
      ts: '2026-04-27T12:34:56.000Z',
    }

    expect(schema.safeParse?.(validEvent).success).toBe(true)

    expect(
      schema.safeParse?.({
        ...validEvent,
        result: 'unexpected_result',
      }).success
    ).toBe(false)

    expect(
      schema.safeParse?.({
        ...validEvent,
        replayed: 'false',
      }).success
    ).toBe(false)

    expect(
      schema.safeParse?.({
        ...validEvent,
        ts: 'not an iso timestamp',
      }).success
    ).toBe(false)
  })

  it('requires structured monitor harness audit coverage', () => {
    const auditPath = join(import.meta.dir, '../../MONITOR_HARNESS_AUDIT.md')

    expect(existsSync(auditPath)).toBe(true)

    const audit = readFileSync(auditPath, 'utf8')

    for (const harness of ['Claude', 'Codex', 'Pi', 'tmux']) {
      const section = audit.match(
        new RegExp(`^##+\\s+${harness}\\b(?<body>[\\s\\S]*?)(?=^##+\\s+|\\z)`, 'm')
      )?.groups?.body

      expect(section, `${harness} section is missing`).toBeString()

      const gaps = section?.match(/(^###+\s+Gaps\b(?<body>[\s\S]*?)(?=^###+\s+|^##+\s+|\z))/m)
        ?.groups?.body

      expect(gaps, `${harness} Gaps subsection is missing`).toBeString()
      expect(
        /(^\s*[-*]\s+\S)|(^\s*\|.*\|\s*$)/m.test(gaps ?? ''),
        `${harness} Gaps subsection must use a markdown list or table`
      ).toBe(true)
    }
  })
})
