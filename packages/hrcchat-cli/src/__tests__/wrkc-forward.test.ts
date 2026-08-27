/**
 * `hrcchat dm` -> `wrkc say` argv contract (T-07612 §9.2, T-07616 flag day).
 *
 * The mapping is the whole shim: everything else is a spawn. Every row here is
 * a spelling that exists in scripts across the collective on flag day.
 */
import { describe, expect, it } from 'bun:test'

import { mapDmToWrkcSay, stripBirthDirectives } from '../wrkc-forward.js'

function forward(...args: Parameters<typeof mapDmToWrkcSay>) {
  const plan = mapDmToWrkcSay(...args)
  if (plan.kind !== 'forward') throw new Error(`expected forward, got refuse: ${plan.message}`)
  return plan
}

describe('mapDmToWrkcSay', () => {
  it('addresses the target explicitly: a bare dm always fired, and a say without --to does not', () => {
    const { argv } = forward('cody@agent-control-plane:T-07616', 'hello', {})
    expect(argv).toEqual([
      'say',
      'cody@agent-control-plane:T-07616',
      'hello',
      '--to',
      'cody@agent-control-plane:T-07616',
    ])
  })

  it('routes the human target to the lance principal on both the ref and the addressee', () => {
    const { argv } = forward('human', 'status', {})
    expect(argv).toEqual(['say', 'lance', 'status', '--to', 'lance'])
  })

  it('keeps birth directives on the ref and off the addressee', () => {
    const { argv } = forward('clod@hrc-runtime:primary +node=mini', 'go', {})
    expect(argv[1]).toBe('clod@hrc-runtime:primary +node=mini')
    expect(argv[argv.indexOf('--to') + 1]).toBe('clod@hrc-runtime:primary')
  })

  it('maps steer and its deprecated alias onto --urgent', () => {
    expect(forward('a@b:primary', 'x', { steer: true }).argv).toContain('--urgent')
    expect(forward('a@b:primary', 'x', { urgent: true }).argv).toContain('--urgent')
  })

  it('maps --wait response onto the group wait, carrying the timeout', () => {
    const { argv } = forward('a@b:primary', 'x', { wait: 'response', timeout: '20m' })
    expect(argv).toContain('--wait')
    expect(argv.slice(argv.indexOf('--timeout'))).toEqual(['--timeout', '20m'])
  })

  it('translates the respond-to KIND into a principal, because wrkc has no kinds', () => {
    const { argv } = forward('a@b:primary', 'x', { respondTo: 'human' })
    expect(argv.slice(argv.indexOf('--respond-to'))).toEqual(['--respond-to', 'agent:lance'])
  })

  it('drops --respond-to agent with a notice rather than inventing a principal', () => {
    const plan = forward('a@b:primary', 'x', { respondTo: 'agent' })
    expect(plan.argv).not.toContain('--respond-to')
    expect(plan.notices.join('\n')).toMatch(/--respond-to agent dropped/)
  })

  it('normalizes a bare sender name into an agent principal', () => {
    expect(forward('a@b:primary', 'x', { as: 'clod' }).argv).toContain('agent:clod')
    expect(forward('a@b:primary', 'x', { as: 'human' }).argv).toContain('agent:lance')
    expect(forward('a@b:primary', 'x', { as: 'agent:mable' }).argv).toContain('agent:mable')
  })

  it('drops --reply-to with a notice: in a room the reply is the ack', () => {
    const plan = forward('a@b:primary', 'x', { replyTo: 'msg-abc' })
    expect(plan.argv).not.toContain('--reply-to')
    expect(plan.notices.join('\n')).toMatch(/reply IS the ack/)
  })

  it('drops --queue, --mode, --quiet and --cross-scope-reply with named notices', () => {
    const plan = forward('a@b:primary', 'x', {
      queue: true,
      mode: 'headless',
      quiet: true,
      crossScopeReply: true,
    })
    expect(plan.argv).toEqual(['say', 'a@b:primary', 'x', '--to', 'a@b:primary'])
    const notices = plan.notices.join('\n')
    expect(notices).toMatch(/--queue dropped/)
    expect(notices).toMatch(/--mode headless dropped/)
    expect(notices).toMatch(/--quiet dropped/)
    expect(notices).toMatch(/--cross-scope-reply dropped/)
  })

  it('refuses --follow instead of silently dropping the caller’s only progress signal', () => {
    const plan = mapDmToWrkcSay('a@b:primary', 'x', { follow: '30s' })
    expect(plan.kind).toBe('refuse')
    if (plan.kind !== 'refuse') throw new Error('unreachable')
    expect(plan.message).toMatch(/hrc monitor watch EN-xxxxx/)
  })

  it('refuses the system target: a note addressed to nobody is a room log entry', () => {
    const plan = mapDmToWrkcSay('system', 'note', {})
    expect(plan.kind).toBe('refuse')
    if (plan.kind !== 'refuse') throw new Error('unreachable')
    expect(plan.message).toMatch(/wrkc say <room>` with no --to/)
  })

  it('passes a stdin body marker through unchanged', () => {
    expect(forward('a@b:primary', '-', {}).argv).toEqual([
      'say',
      'a@b:primary',
      '-',
      '--to',
      'a@b:primary',
    ])
  })
})

describe('stripBirthDirectives', () => {
  it('removes every + token and keeps the handle', () => {
    expect(stripBirthDirectives('clod@hrc-runtime:T-1 +node=mini +model=opus')).toBe(
      'clod@hrc-runtime:T-1'
    )
  })
})
