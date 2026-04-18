/**
 * Unit tests for launchd integration in the hrc server commands.
 *
 * These tests exercise detectLaunchdOwner() and launchctlKickstart() by
 * shimming the `launchctl` binary via PATH. They run on macOS only; on
 * other platforms detectLaunchdOwner short-circuits to null without
 * spawning a subprocess, and we assert that behavior directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectLaunchdOwner, launchctlKickstart } from '../cli-runtime'

type Shim = {
  dir: string
  logFile: string
}

const IS_DARWIN = process.platform === 'darwin'

async function writeShim(opts: { exitCode: number }): Promise<Shim> {
  const dir = await mkdtemp(join(tmpdir(), 'launchctl-shim-'))
  const shimPath = join(dir, 'launchctl')
  const logFile = join(dir, 'invocations.log')

  const script = `#!/bin/bash
printf '%s\\n' "$*" >> "${logFile}"
exit ${opts.exitCode}
`
  await writeFile(shimPath, script)
  await chmod(shimPath, 0o755)
  return { dir, logFile }
}

describe('detectLaunchdOwner', () => {
  let originalPath: string | undefined
  let originalLabel: string | undefined
  let shim: Shim | null = null

  beforeEach(() => {
    originalPath = process.env.PATH
    originalLabel = process.env.HRC_LAUNCHD_LABEL
  })

  afterEach(async () => {
    process.env.PATH = originalPath
    if (originalLabel === undefined) {
      process.env.HRC_LAUNCHD_LABEL = undefined
    } else {
      process.env.HRC_LAUNCHD_LABEL = originalLabel
    }
    if (shim) {
      await rm(shim.dir, { recursive: true, force: true })
      shim = null
    }
  })

  it.if(!IS_DARWIN)('returns null on non-darwin platforms without spawning', async () => {
    const owner = await detectLaunchdOwner()
    expect(owner).toBeNull()
  })

  it.if(IS_DARWIN)('returns owner when launchctl print exits 0', async () => {
    shim = await writeShim({ exitCode: 0 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`
    process.env.HRC_LAUNCHD_LABEL = 'com.example.test-hrc'

    const owner = await detectLaunchdOwner()
    expect(owner).not.toBeNull()
    expect(owner?.label).toBe('com.example.test-hrc')
    expect(owner?.domain).toMatch(/^gui\/\d+$/)
    expect(owner?.serviceTarget).toBe(`${owner?.domain}/com.example.test-hrc`)

    const log = await readFile(shim.logFile, 'utf8')
    expect(log).toContain(`print ${owner?.serviceTarget}`)
  })

  it.if(IS_DARWIN)('returns null when launchctl print exits non-zero', async () => {
    shim = await writeShim({ exitCode: 113 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`
    process.env.HRC_LAUNCHD_LABEL = 'com.example.not-loaded'

    const owner = await detectLaunchdOwner()
    expect(owner).toBeNull()
  })
})

describe('launchctlKickstart', () => {
  let originalPath: string | undefined
  let shim: Shim | null = null

  beforeEach(() => {
    originalPath = process.env.PATH
  })

  afterEach(async () => {
    process.env.PATH = originalPath
    if (shim) {
      await rm(shim.dir, { recursive: true, force: true })
      shim = null
    }
  })

  it.if(IS_DARWIN)('invokes launchctl kickstart without -k by default', async () => {
    shim = await writeShim({ exitCode: 0 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

    await launchctlKickstart({
      label: 'com.example.hrc',
      domain: 'gui/501',
      serviceTarget: 'gui/501/com.example.hrc',
    })

    const log = await readFile(shim.logFile, 'utf8')
    expect(log.trim()).toBe('kickstart gui/501/com.example.hrc')
  })

  it.if(IS_DARWIN)('adds -k when opts.kill is true', async () => {
    shim = await writeShim({ exitCode: 0 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

    await launchctlKickstart(
      {
        label: 'com.example.hrc',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.example.hrc',
      },
      { kill: true }
    )

    const log = await readFile(shim.logFile, 'utf8')
    expect(log.trim()).toBe('kickstart -k gui/501/com.example.hrc')
  })
})
