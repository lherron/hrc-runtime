import { describe, expect, test } from 'bun:test'
import type { Command } from 'commander'

import { toLegacyArgvForScopeCommand } from '../cli/argv.js'
import { buildProgram } from '../cli/build-program.js'
import { allCommandNodes } from '../cli/command-metadata.js'
import { legacyArgvSchema, startOptions } from '../cli/scope-verb-options.js'
import { parseScopePrompt } from '../cli/scope.js'
import { runCli } from './fixtures/cli.fixture.js'

async function parse(args: string[]): Promise<{ root: Command; command: Command }> {
  const root = buildProgram()
  let selected: Command | undefined
  for (const command of allCommandNodes(root)) {
    command.action(() => {
      selected = command
    })
  }
  await root.parseAsync(args, { from: 'user' })
  if (!selected) throw new Error('no command dispatched')
  return { root, command: selected }
}

describe('CLI option ownership', () => {
  for (const path of [
    ['runtime', 'list'],
    ['monitor', 'search', 'query'],
  ]) {
    test(`${path.join(' ')} owns spaced and equals --agent filters`, async () => {
      for (const flags of [['--agent', 'astra'], ['--agent=astra']]) {
        const { root, command } = await parse([...path, ...flags, '--json'])
        expect(command.opts()).toMatchObject({ agent: 'astra', json: true })
        expect(root.opts().agent).toBeUndefined()
      }
    })
  }

  test('every root/child collision resolves to the local declaration', async () => {
    const root = buildProgram()
    const collisions = allCommandNodes(root).flatMap((command) =>
      command === root
        ? []
        : command.options
            .filter(
              (option) =>
                !option.hidden && root.options.some((global) => global.long === option.long)
            )
            .map((option) => ({ command, option }))
    )
    expect(
      collisions.filter(({ option }) => option.required).map(({ option }) => option.long)
    ).toEqual(['--agent', '--agent'])
  })

  test('global output works before, between and after command names', async () => {
    for (const args of [
      ['--output', 'json', 'runtime', 'list'],
      ['runtime', '--output', 'json', 'list'],
      ['runtime', 'list', '--output=json'],
    ]) {
      const { root, command } = await parse(args)
      expect(root.opts().output).toBe('json')
      expect(command.opts().json).toBe(true)
    }
  })

  test('fallback globals stay out of scope-command legacy arguments', async () => {
    const { command } = await parse(['start', 'astra', '--output', 'json', '-p', 'the prompt'])
    const args = toLegacyArgvForScopeCommand(
      command.args,
      command.opts(),
      [],
      legacyArgvSchema(command.options)
    )
    expect(args).not.toContain('--output')
    expect(await parseScopePrompt(args, { command: 'start', options: startOptions() })).toBe(
      'the prompt'
    )
  })

  test('literal delimiter preserves flag-looking positionals', async () => {
    const { command } = await parse(['runtime', 'inspect', '--', '--agent'])
    expect(command.args).toEqual(['--agent'])
    expect(command.opts().agent).toBeUndefined()
  })

  test('help validation uses parsed option values, including variadic and short flags', async () => {
    for (const args of [
      ['runtime', 'list', '--agent', 'astra', '--help'],
      ['monitor', 'search', 'query', '--agent', 'astra', '--help'],
      ['server', 'serve', '--allow-persona', 'astra', 'cody', '--help'],
      ['start', '-phello', '--help'],
    ]) {
      const result = await runCli(args)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Usage:')
      expect(result.stderr).toBe('')
    }
  })

  test('unknown commands before help retain scoped diagnostics', async () => {
    for (const args of [
      ['runtime', 'lst', '--help'],
      ['runtime', '--output', 'json', 'lst', '--help'],
    ]) {
      const result = await runCli(args)
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('unknown command: lst')
    }
  })

  test('audience root/info forms and aliases retain their contracts', async () => {
    for (const audience of ['agent', 'human']) {
      for (const args of [
        [`--${audience}`, '--help'],
        ['info', `--${audience}`],
        [`--${audience}`, 'info'],
      ]) {
        const result = await runCli(args)
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain(`VIEW: ${audience}`)
      }
    }
    const alias = await runCli(['list', '--help'])
    expect(alias.exitCode).toBe(0)
  })

  test('output alias preserves JSON usage errors and rejects unsupported commands', async () => {
    for (const args of [
      ['--output', 'json', 'runtime', 'inspect'],
      ['runtime', 'inspect', '--output', 'json'],
      ['info', '--output', 'json', '--human', '--agent'],
      ['server', 'serve', '--output', 'json'],
    ]) {
      const result = await runCli(args)
      expect(result.exitCode).toBe(2)
      expect(JSON.parse(result.stderr)).toHaveProperty('error')
      expect(result.stdout).toBe('')
    }
  })
})
