import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { buildProgram } from '../main.js'

const MAIN = join(import.meta.dir, '..', 'main.ts')

describe('hrcmail CLI surface', () => {
  it('registers the ratified standalone command roster', () => {
    expect(buildProgram().commands.map((command) => command.name())).toEqual([
      'inbox',
      'ack',
      'defer',
      'send',
      'cat',
      'ls',
    ])
  })

  it('boots its source entrypoint and renders help without contacting the daemon', () => {
    const result = Bun.spawnSync([process.execPath, MAIN, '--help'])
    const stdout = result.stdout.toString()

    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    expect(stdout).toContain('durable embedded-envelope mailbox')
    expect(stdout).toContain('inbox')
    expect(stdout).toContain('ack')
    expect(stdout).toContain('defer')
    expect(stdout).toContain('send')
    expect(stdout).toContain('cat')
    expect(stdout).toContain('ls')
  })
})
