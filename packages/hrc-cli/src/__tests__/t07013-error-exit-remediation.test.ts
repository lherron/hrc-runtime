import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { CliUsageError } from 'cli-kit'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { resolveOtelPreferredPortFromEnv } from '../cli-runtime/otel-env.js'
import { validateDiagnosticRoot } from '../cli-runtime/server-paths.js'
import { buildProgram } from '../cli/build-program.js'
import { emitScopeCommandErrorJson } from '../cli/errors.js'
import { handleCliError } from '../cli/program.js'
import { CliStatusExit } from '../cli/shared.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const HRC_ENTRY = join(REPO_ROOT, 'packages', 'hrc-cli', 'src', 'cli.ts')
const tempRoots: string[] = []

async function runCli(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'run', HRC_ENTRY, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('T-07013 usage/internal exit taxonomy', () => {
  test('bare hrc is usage exit 2', async () => {
    const result = await runCli([])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  test('input-shaped HrcDomainError exits 2 and preserves structured detail', () => {
    const originalExit = process.exit
    const originalWrite = process.stderr.write
    const chunks: string[] = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as typeof process.exit

    try {
      expect(() =>
        handleCliError(
          new HrcDomainError(HrcErrorCode.INVALID_SELECTOR, 'bad selector', {
            selector: 'rutnime:123',
          }),
          buildProgram()
        )
      ).toThrow('exit:2')
      expect(chunks.join('')).toContain('selector')
    } finally {
      process.exit = originalExit
      process.stderr.write = originalWrite
    }
  })

  test('config validation failures are CliUsageError instances', async () => {
    expect(() =>
      resolveOtelPreferredPortFromEnv({ HRC_OTLP_PREFERRED_PORT: 'not-a-port' })
    ).toThrow(CliUsageError)

    const root = await mkdtemp(join(tmpdir(), 'hrc-t07013-path-'))
    tempRoots.push(root)
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'x')
    expect(() => validateDiagnosticRoot(file, 'runtime root')).toThrow(CliUsageError)
  })

  test.each([
    ['no session exists for "cody"', 'session_not_found'],
    ['session exists but has no live runtime', 'runtime_not_found'],
    ['agent "nobody" not found', 'agent_not_found'],
  ])('scope JSON maps %s to stable code %s', (message, code) => {
    const originalWrite = process.stdout.write
    const chunks: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      expect(() => emitScopeCommandErrorJson('attach', new Error(message), 'cody')).toThrow()
      expect(JSON.parse(chunks.join(''))).toMatchObject({
        error: { code, command: 'attach', scope: 'cody' },
      })
    } finally {
      process.stdout.write = originalWrite
    }
  })

  test('scope JSON keeps invalid input on usage exit 2', () => {
    const originalWrite = process.stdout.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      let thrown: unknown
      try {
        emitScopeCommandErrorJson(
          'run',
          new HrcDomainError(HrcErrorCode.INVALID_SELECTOR, 'bad scope'),
          'bad'
        )
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CliStatusExit)
      expect((thrown as CliStatusExit).code).toBe(2)
    } finally {
      process.stdout.write = originalWrite
    }
  })
})

describe('T-07013 entry-path validation', () => {
  test.each([
    [['rutnime', '--help'], 'unknown command: rutnime'],
    [['runtime', 'lst', '--help'], 'unknown command: lst'],
    [['admin', 'rns', '--help'], 'unknown command: rns'],
  ])('unknown path %p is rejected before help', async (args, message) => {
    const result = await runCli(args)
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(message)
  })

  test('suggestion fallback lists sibling commands when edit distance has no match', async () => {
    const result = await runCli(['admin', 'runs', 'completely-unrelated'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Available commands:')
    expect(result.stderr).toContain('sweep-zombies')
  })

  test('commander fallback includes command context and usage synopsis', async () => {
    const result = await runCli(['runtime', 'inspect'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('command: hrc runtime inspect')
    expect(result.stderr).toContain('usage:')
  })

  test.each([
    ['run', ['cody', '--dr-run']],
    ['resume', ['cody', '--dr-run']],
    ['ls', ['runtimes', '--statsu', 'busy']],
  ])('%s rejects typoed flags instead of dropping them', async (command, rest) => {
    const result = await runCli([command, ...rest])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('unknown option:')
  })

  test('turn forwards typoed flags to hrcchat, which rejects them', async () => {
    const result = await runCli(['turn', '--definitely-not-a-real-flag'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/unknown option/)
  })
})
