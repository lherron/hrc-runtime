import { CliUsageError } from 'cli-kit'
import type { HrcMonitorCondition } from 'hrc-core'
import type { MonitorSelectorSpec } from './selector-shape.js'

export type MonitorQuantifier = 'exact' | 'any' | 'all'
export type MonitorUntilFamily = 'until' | 'until-any' | 'until-all'

export type MonitorUntilPlan = {
  family: MonitorUntilFamily
  quantifier: MonitorQuantifier
  conditions: HrcMonitorCondition[]
  implicit: boolean
}

export type MonitorUntilInput = {
  until?: string | readonly string[] | undefined
  untilAny?: readonly string[] | undefined
  untilAll?: readonly string[] | undefined
}

const LEVEL_CONDITIONS = new Set<string>(['idle', 'busy', 'runtime-dead'])
const EDGE_CONDITIONS = new Set<string>(['turn-finished', 'response'])
const VALID_CONDITIONS = new Set([...LEVEL_CONDITIONS, ...EDGE_CONDITIONS])

export function appendUntilValue(
  target: Partial<Record<MonitorUntilFamily, string[]>>,
  family: MonitorUntilFamily,
  value: string
): void {
  const values = target[family] ?? []
  values.push(value)
  target[family] = values
}

export function resolveMonitorUntilPlan(
  input: MonitorUntilInput,
  specs: readonly MonitorSelectorSpec[],
  options: { defaultWhenBlocking: boolean }
): MonitorUntilPlan | undefined {
  const exactValues = normalizeValues(input.until)
  const families = [
    ['until', exactValues] as const,
    ['until-any', [...(input.untilAny ?? [])]] as const,
    ['until-all', [...(input.untilAll ?? [])]] as const,
  ].filter((entry) => entry[1].length > 0)

  if (families.length > 1) {
    throw new CliUsageError('--until, --until-any, and --until-all are mutually exclusive')
  }

  const setShaped = specs.length !== 1 || specs[0]?.kind !== 'exact'
  const implicit = families.length === 0 && options.defaultWhenBlocking
  const selectedFamily = families[0]
  const family = implicit ? (setShaped ? 'until-any' : 'until') : selectedFamily?.[0]
  if (family === undefined) return undefined
  const conditions = implicit ? ['turn-finished', 'runtime-dead'] : (selectedFamily?.[1] ?? [])

  for (const condition of conditions) {
    if (!VALID_CONDITIONS.has(condition)) {
      throw new CliUsageError(
        `invalid condition: ${condition} (valid: ${[...VALID_CONDITIONS].join(', ')})`
      )
    }
  }

  if (setShaped && family === 'until') {
    throw new CliUsageError('set-shaped selectors require --until-any or --until-all')
  }
  if (!setShaped && family !== 'until') {
    throw new CliUsageError('exact selectors require --until')
  }
  if (family === 'until-all' && conditions.some((condition) => !LEVEL_CONDITIONS.has(condition))) {
    throw new CliUsageError('--until-all accepts level conditions only: idle, busy, runtime-dead')
  }
  if (conditions.includes('response')) {
    const selector =
      specs.length === 1 && specs[0]?.kind === 'exact' ? specs[0].selector : undefined
    if (
      family !== 'until' ||
      !selector ||
      (selector.kind !== 'message' && selector.kind !== 'message-seq')
    ) {
      throw new CliUsageError('response requires exactly one msg: or seq: selector under --until')
    }
  }

  return {
    family,
    quantifier: family === 'until' ? 'exact' : family === 'until-any' ? 'any' : 'all',
    conditions: conditions as HrcMonitorCondition[],
    implicit,
  }
}

export function isLevelCondition(condition: string): boolean {
  return LEVEL_CONDITIONS.has(condition)
}

function normalizeValues(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []
  return typeof value === 'string' ? [value] : [...value]
}
