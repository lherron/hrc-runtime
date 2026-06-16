import { describe, expect, test } from 'bun:test'
import { Command } from 'commander'

import {
  type Registry,
  buildRegistry,
  checkClaims,
  checkRosterCompleteness,
  collectFindings,
  extractClaims,
} from './check-cli-surface.ts'

// A small stand-in CLI so the fires-on-bad cases don't depend on the real surface.
function toyRegistry(): Registry {
  const program = new Command().name('hrc')
  program
    .command('dm')
    .option('--respond-to <kind>', 'recipient kind')
    .action(() => {})
  const monitor = program.command('monitor') // pure group: no action → subcommand required
  monitor
    .command('watch')
    .option('--follow <duration>', 'follow')
    .action(() => {})
  return buildRegistry('hrc', program)
}

describe('check-cli-surface — passes on good', () => {
  test('the live hrc + hrcchat surfaces are conformant', () => {
    // Guards the real CLIs against future help/registry drift.
    expect(collectFindings()).toHaveLength(0)
  })
})

describe('check-cli-surface — fires on bad', () => {
  const registries = { hrc: toyRegistry() }

  test('unknown command in a curated example', () => {
    const claims = extractClaims('test', '  hrc frobnicate cody@x')
    const findings = checkClaims(registries, claims)
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('unknown-command')
  })

  test('unknown subcommand of a group', () => {
    const claims = extractClaims('test', '  hrc monitor bogus cody@x')
    const findings = checkClaims(registries, claims)
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('unknown-subcommand')
  })

  test('unknown flag on a real command', () => {
    const claims = extractClaims('test', '  hrc dm cody@x --nope')
    const findings = checkClaims(registries, claims)
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('unknown-flag')
  })

  test('command missing from the rendered roster', () => {
    const infoText = '...\nCOMMANDS\n  dm        send a message\n\nNEXT STEP\n'
    const findings = checkRosterCompleteness(registries.hrc, infoText)
    // `monitor` is registered+visible but absent from the roster.
    expect(findings.map((finding) => finding.token)).toContain('hrc monitor')
    expect(findings[0].kind).toBe('undocumented-command')
  })
})

describe('check-cli-surface — no false positives on prose', () => {
  test('prose that merely mentions the binary is not a claim', () => {
    const claims = extractClaims('test', '  Use hrc to control HRC itself.')
    expect(claims).toHaveLength(0)
  })

  test('a command-shaped example is a claim', () => {
    const claims = extractClaims('test', '  hrc dm cody@x --respond-to human')
    expect(claims).toHaveLength(1)
  })
})
