import { describe, expect, test } from 'bun:test'

import { buildProgram } from '../cli/build-program.js'
import { allCommandNodes, commandMetadata } from '../cli/command-metadata.js'
import { buildInfoText, renderRootHelp, resolveHelpView } from '../cli/help.js'

describe('audience help view selection', () => {
  test('uses explicit flag before agent identity before the TTY tiebreak', () => {
    const agentEnv = { ASP_AGENT_ID: 'cody' }

    expect(resolveHelpView({ human: true }, { env: agentEnv, isTTY: false })).toBe('human')
    expect(resolveHelpView({ agent: true }, { env: {}, isTTY: true })).toBe('agent')
    expect(resolveHelpView({}, { env: agentEnv, isTTY: true })).toBe('agent')
    expect(resolveHelpView({}, { env: {}, isTTY: false })).toBe('agent')
    expect(resolveHelpView({}, { env: {}, isTTY: true })).toBe('human')
  })

  test('rejects conflicting explicit view flags', () => {
    expect(() => resolveHelpView({ agent: true, human: true }, { env: {}, isTTY: true })).toThrow(
      '--agent and --human are mutually exclusive'
    )
  })
})

describe('Commander graph metadata projections', () => {
  const program = buildProgram()

  test('attaches complete audience and human-summary metadata to every registered node', () => {
    for (const command of allCommandNodes(program)) {
      const metadata = commandMetadata(command)
      expect(['agent', 'human', 'both']).toContain(metadata.audience)
      expect(metadata.humanSummary).toBe(command.description())
    }
  })

  test('renders distinct labeled root projections from the same graph', () => {
    const agent = renderRootHelp(program, 'agent')
    const human = renderRootHelp(program, 'human')

    expect(agent).toContain('VIEW: agent')
    expect(agent).toContain('monitor wait')
    expect(agent).not.toMatch(/\n\s+admin\s+administrative/)
    expect(human).toContain('VIEW: human')
    expect(human).toContain('GROUPS')
    expect(human).toMatch(/\n\s+admin\s+administrative/)
    expect(human).toContain('hrc run <target>')
    for (const text of [agent, human]) {
      expect(text).toContain('hrc admin --help')
      expect(text).toContain('Run hrc <command> --help')
    }
  })

  test('agent info documents distinct cursors and continuation-only resume semantics', () => {
    const info = buildInfoText(program, undefined, 'agent')

    expect(info).toContain('global hrcSeq')
    expect(info).toContain('invocation-local broker seq')
    expect(info).toContain('Monitor conditions NEVER evaluate the broker invocation ledger.')
    expect(info).toContain('0 matched (success); 10 already true at arm (success)')
    expect(info).toContain('11 no session ever (not_matched)')
    expect(info).toContain('13 terminal failure (observed_failure)')
    expect(info).toContain('23 monitor error (error)')
    expect(info).toContain('130 SIGINT')
    expect(info).toContain('continuation-only recovery')
    expect(info).not.toContain('exact alias of run')
  })
})
