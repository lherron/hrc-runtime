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

import {
  detectLaunchdOwner,
  launchctlKickstart,
  resolveOtelPreferredPortFromEnv,
} from '../cli-runtime'

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

  it.if(IS_DARWIN)('uses HRC_LAUNCHD_LABEL to select the hrc-dev service', async () => {
    shim = await writeShim({ exitCode: 0 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`
    process.env.HRC_LAUNCHD_LABEL = 'com.praesidium.hrc-dev'

    const owner = await detectLaunchdOwner()
    expect(owner?.label).toBe('com.praesidium.hrc-dev')
    expect(owner?.serviceTarget).toBe(`${owner?.domain}/com.praesidium.hrc-dev`)

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

describe('hrc-dev LaunchAgent and OTLP env', () => {
  it('dev plist uses isolated roots, label, logs, wrapper, and OTLP preferred port', async () => {
    const plistPath = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      'launchd',
      'com.praesidium.hrc-dev.plist'
    )
    const plist = await readFile(plistPath, 'utf8')

    expect(plist).toContain('<string>com.praesidium.hrc-dev</string>')
    expect(plist).toContain('<string>/Users/lherron/.bun/bin/hrc-dev</string>')
    expect(plist).toContain('<key>HRC_RUNTIME_DIR</key>')
    expect(plist).toContain('<string>/Users/lherron/praesidium/var/run/hrc-dev</string>')
    expect(plist).toContain('<key>HRC_STATE_DIR</key>')
    expect(plist).toContain('<string>/Users/lherron/praesidium/var/state/hrc-dev</string>')
    expect(plist).toContain('<key>HRC_OTLP_PREFERRED_PORT</key>')
    expect(plist).toContain('<string>4319</string>')
    expect(plist).toContain('/Users/lherron/praesidium/var/logs/hrc-dev-server.log')
    expect(plist).toContain('/Users/lherron/praesidium/var/logs/hrc-dev-server.err.log')
  })

  it('parses HRC_OTLP_PREFERRED_PORT into the server otelPreferredPort option value', () => {
    expect(resolveOtelPreferredPortFromEnv({ HRC_OTLP_PREFERRED_PORT: '4319' })).toBe(4319)
  })

  it('accepts HRC_OTEL_PREFERRED_PORT as an alias for the option name', () => {
    expect(resolveOtelPreferredPortFromEnv({ HRC_OTEL_PREFERRED_PORT: '4320' })).toBe(4320)
  })

  it('rejects invalid OTLP preferred ports', () => {
    expect(() => resolveOtelPreferredPortFromEnv({ HRC_OTLP_PREFERRED_PORT: 'nope' })).toThrow(
      /integer port/
    )
    expect(() => resolveOtelPreferredPortFromEnv({ HRC_OTLP_PREFERRED_PORT: '65536' })).toThrow(
      /between 0 and 65535/
    )
  })
})

describe('hrc delta-prune LaunchAgent', () => {
  it('schedules the honest delta prune nightly without vacuum or KeepAlive', async () => {
    const plistPath = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      'launchd',
      'com.praesidium.hrc-prune-deltas.plist'
    )
    const plist = await readFile(plistPath, 'utf8')

    expect(plist).toContain('<string>com.praesidium.hrc-prune-deltas</string>')
    expect(plist).toContain('<string>/Users/lherron/.bun/bin/bun</string>')
    expect(plist).toContain(
      '<string>/Users/lherron/praesidium/hrc-runtime/scripts/prune-hrc-event-deltas.ts</string>'
    )
    expect(plist).toContain('<string>--apply</string>')
    expect(plist).toContain('<key>StartCalendarInterval</key>')
    expect(plist).toContain('<key>HRC_STATE_DIR</key>')
    expect(plist).toContain('<string>/Users/lherron/praesidium/var/state/hrc</string>')
    expect(plist).toContain('/Users/lherron/praesidium/var/logs/hrc-prune-deltas.log')
    expect(plist).toContain('/Users/lherron/praesidium/var/logs/hrc-prune-deltas.err.log')
    expect(plist).not.toContain('--vacuum')
    expect(plist).not.toContain('<key>KeepAlive</key>')
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
