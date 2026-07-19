import type { HrcMonitorState } from 'hrc-core'
import type { MonitorConditionMember } from './aggregate-render.js'
import type { MonitorQuantifier } from './until-args.js'

export function writeMonitorArmReport(
  stderr: { write(chunk: string): boolean },
  input: {
    selector: string
    quantifier: MonitorQuantifier
    conditions: readonly string[]
    observedAt: string
    members: readonly MonitorConditionMember[]
    state: HrcMonitorState
  }
): void {
  stderr.write(
    `${JSON.stringify({
      event: 'monitor.armed',
      selector: input.selector,
      quantifier: input.quantifier,
      conditions: input.conditions,
      observedAt: input.observedAt,
      members: input.members,
      sessionCount: input.state.sessions.length,
      runtimeCount: input.state.runtimes.length,
      phase: 'at-arm',
    })}\n`
  )
}

export function writeAllAlreadyTrueReport(
  stderr: { write(chunk: string): boolean },
  condition: string | undefined,
  members: readonly MonitorConditionMember[]
): void {
  if (condition === undefined) {
    const matchedConditions = [
      ...new Set(
        members.flatMap((member) =>
          member.matchedCondition === undefined ? [] : [member.matchedCondition]
        )
      ),
    ]
    stderr.write(
      `all members already satisfy one of ${matchedConditions.join(', ')}; per-member transition times are reported in monitor.armed\n`
    )
    return
  }
  const latest = members
    .map((member) => member.statusChangedAt)
    .filter((value) => value !== 'unknown')
    .sort()
    .at(-1)
  stderr.write(
    `all are already ${condition}; last one went ${condition}${latest ? ` ${latest}` : ''}\n`
  )
}

export function writeExactAlreadyTrueReport(
  stderr: { write(chunk: string): boolean },
  member: MonitorConditionMember,
  condition: string
): void {
  if (condition === 'idle') {
    stderr.write(
      `not busy now; went idle ${member.statusChangedAt}; nothing in flight to wait on\n`
    )
  } else if (condition === 'runtime-dead') {
    stderr.write(`runtime dead since ${member.statusChangedAt}\n`)
  }
}
