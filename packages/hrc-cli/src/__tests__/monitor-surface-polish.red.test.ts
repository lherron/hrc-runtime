import { describe, expect, test } from 'bun:test'
import type { Command } from 'commander'

import { buildProgram } from '../cli/build-program.js'
import { buildInfoText } from '../cli/usage.js'
import { VALID_CONDITIONS } from '../monitor-conditions.js'
import { resolveMonitorOutputFormat } from '../monitor-render.js'

const EXIT_CODE_HELP = [
  '0 satisfied/replay-complete',
  '1 timeout/stall',
  '2 usage/invalid selector',
  '3 monitor infra failure',
  '4 condition impossible',
  '130 SIGINT',
] as const

function findCommand(...path: string[]): Command {
  let command = buildProgram()
  for (const name of path) {
    const child = command.commands.find((candidate) => candidate.name() === name)
    if (!child) throw new Error(`missing command: ${path.join(' ')}`)
    command = child
  }
  return command
}

function commandHelp(...path: string[]): string {
  const command = findCommand(...path)
  let output = ''
  command.configureOutput({
    writeOut: (text) => {
      output += text
    },
  })
  command.outputHelp()
  return output.replace(/\s+/g, ' ').trim()
}

function expectConditionAndExitCodeHelp(help: string): void {
  for (const condition of VALID_CONDITIONS) {
    expect(help).toContain(condition)
  }
  for (const exitCode of EXIT_CODE_HELP) {
    expect(help).toContain(exitCode)
  }
}

describe('hrc monitor surface polish', () => {
  test('monitor watch defaults by TTY while every explicit format selector wins', () => {
    const resolveWithTty = resolveMonitorOutputFormat as (
      options: Parameters<typeof resolveMonitorOutputFormat>[0],
      isTTY: boolean
    ) => ReturnType<typeof resolveMonitorOutputFormat>

    expect(resolveWithTty({}, false)).toBe('ndjson')
    expect(resolveWithTty({}, true)).toBe('tree')

    for (const isTTY of [false, true]) {
      expect(resolveWithTty({ format: 'compact' }, isTTY)).toBe('compact')
      expect(resolveWithTty({ pretty: true }, isTTY)).toBe('tree')
      expect(resolveWithTty({ json: true }, isTTY)).toBe('ndjson')
    }
  })

  test('monitor watch help documents conditions, coupling, exits, and its dynamic default', () => {
    const help = commandHelp('monitor', 'watch')

    expectConditionAndExitCodeHelp(help)
    expect(help).toContain('--until requires --follow')
    expect(help).toMatch(/response.*response-or-idle.*require.*msg: selector/i)
    expect(help).toContain('--stall-after exits the stream (it is not a pause signal)')
    expect(help).toMatch(/default (?:output )?format.*tree.*TTY.*ndjson.*not a TTY/i)
  })

  test('monitor wait help presents the shared condition engine without an event stream', () => {
    const help = commandHelp('monitor', 'wait')

    expect(help).toContain('watch --until without the event stream')
    expectConditionAndExitCodeHelp(help)
  })

  test('AC9: terminal help and monitor docs explain fences, fan-in, and duration risk', async () => {
    const waitHelp = commandHelp('monitor', 'wait')
    const watchHelp = commandHelp('monitor', 'watch')
    const monitorDocs = await Bun.file(
      new URL('../../../../docs/monitor-spec.md', import.meta.url)
    ).text()
    const cliDocs = await Bun.file(
      new URL('../../../../docs/cli-reference.md', import.meta.url)
    ).text()
    const documented = `${monitorDocs}\n${cliDocs}`

    for (const help of [waitHelp, watchHelp]) {
      expect(help).toContain('--since <seq|duration>')
      expect(help).toMatch(/first terminal.*any matching scope.*not room.*completion/i)
    }
    expect(documented).toMatch(/--since.*post-finish/i)
    expect(documented).toMatch(/exact cursor.*scripts/i)
    expect(documented).toMatch(/duration.*human convenience/i)
    expect(documented).toMatch(/duration.*prior attempt/i)
    expect(documented).toMatch(/wrkq monitor wait --until all-terminal/i)
  })

  test('hrc info includes monitor supervision, completion, replay, and dialect guidance', () => {
    const info = buildInfoText(buildProgram())

    expect(info).toContain('MONITOR')
    expect(info).toContain('hrc monitor watch T-XXXXX --follow')
    expect(info).toContain('hrc monitor wait T-XXXXX --until terminal')
    expect(info).toContain('hrc monitor watch T-XXXXX --last N')
    expect(info).toContain('hrc monitor watch T-XXXXX --from-seq N')
    expect(info).toContain('hrc conditions are runtime-centric')
    expect(info).toContain('terminal')
    expect(info).toContain('idle')
    expect(info).toContain('turn-finished')
    expect(info).toContain('wrkq conditions are task-state')
    expect(info).toContain('state=completed')
    expect(info).toContain('all-terminal')
  })

  test('monitor show help distinguishes its snapshot from list surfaces', () => {
    const description = findCommand('monitor', 'show').description()

    expect(description).not.toBe('show current HRC monitor snapshot')
    expect(description).toContain('hrc ls')
    expect(description).toContain('hrc runtime list')
  })
})
