/**
 * Unit tests for launchd integration in the hrc server commands.
 *
 * These tests exercise detectLaunchdOwner() and launchctlKickstart() by
 * shimming the `launchctl` binary via PATH. They run on macOS only; on
 * other platforms detectLaunchdOwner short-circuits to null without
 * spawning a subprocess, and we assert that behavior directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LAUNCHCTL_EALREADY,
  detectLaunchdOwner,
  detectStrandedLaunchAgent,
  formatStrandedLaunchAgentRefusal,
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

/**
 * T-07957. `detectLaunchdOwner` returns null both for a node with no
 * LaunchAgent and for a node whose LaunchAgent is merely not loaded, and the
 * self-daemonize path is only correct for the first. These tests pin the
 * discriminator: plist present + job not loaded + the plist governs THIS
 * runtime root.
 */
describe('detectStrandedLaunchAgent', () => {
  let originalPath: string | undefined
  let originalLabel: string | undefined
  let originalHome: string | undefined
  let originalRuntimeDir: string | undefined
  let shim: Shim | null = null
  let home: string | null = null

  const LABEL = 'com.example.stranded-hrc'

  // Reflect.deleteProperty rather than `process.env.X = undefined`: on Node that
  // assignment stores the STRING "undefined", which the detector would then read
  // as a real HRC_RUNTIME_DIR override.
  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }

  async function writeAgentPlist(env: Record<string, string> | null): Promise<string> {
    home = home ?? (await mkdtemp(join(tmpdir(), 'stranded-home-')))
    const agents = join(home, 'Library', 'LaunchAgents')
    await mkdir(agents, { recursive: true })
    const plistPath = join(agents, `${LABEL}.plist`)
    const envBlock =
      env === null
        ? ''
        : `\t<key>EnvironmentVariables</key>\n\t<dict>\n${Object.entries(env)
            .map(([key, value]) => `\t\t<key>${key}</key>\n\t\t<string>${value}</string>`)
            .join('\n')}\n\t</dict>\n`
    await writeFile(
      plistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `\t<key>Label</key>\n\t<string>${LABEL}</string>`,
        `${envBlock}</dict>`,
        '</plist>',
        '',
      ].join('\n')
    )
    return plistPath
  }

  beforeEach(() => {
    originalPath = process.env.PATH
    originalLabel = process.env.HRC_LAUNCHD_LABEL
    originalHome = process.env.HOME
    originalRuntimeDir = process.env.HRC_RUNTIME_DIR
    process.env.HRC_LAUNCHD_LABEL = LABEL
  })

  afterEach(async () => {
    setEnv('PATH', originalPath)
    setEnv('HRC_LAUNCHD_LABEL', originalLabel)
    setEnv('HOME', originalHome)
    setEnv('HRC_RUNTIME_DIR', originalRuntimeDir)
    if (shim) {
      await rm(shim.dir, { recursive: true, force: true })
      shim = null
    }
    if (home) {
      await rm(home, { recursive: true, force: true })
      home = null
    }
  })

  it.if(!IS_DARWIN)('returns null on non-darwin platforms', async () => {
    expect(await detectStrandedLaunchAgent()).toBeNull()
  })

  it.if(IS_DARWIN)('returns null when no plist exists for the label', async () => {
    // No launchctl shim on PATH at all: absence of a plist must short-circuit
    // before any probe, so unsupervised nodes pay nothing on the start path.
    home = await mkdtemp(join(tmpdir(), 'stranded-home-'))
    process.env.HOME = home
    process.env.HRC_RUNTIME_DIR = join(home, 'run')

    expect(await detectStrandedLaunchAgent()).toBeNull()
  })

  it.if(IS_DARWIN)('returns null when the plist exists and the job IS loaded', async () => {
    const runtimeDir = join(tmpdir(), 'stranded-runtime-loaded')
    await writeAgentPlist({ HRC_RUNTIME_DIR: runtimeDir, HRC_MAIL_KICKER_ENABLED: '1' })
    process.env.HOME = home as string
    process.env.HRC_RUNTIME_DIR = runtimeDir
    shim = await writeShim({ exitCode: 0 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

    expect(await detectStrandedLaunchAgent()).toBeNull()
  })

  it.if(IS_DARWIN)(
    'detects a plist that exists but is not loaded for this runtime root',
    async () => {
      const runtimeDir = join(tmpdir(), 'stranded-runtime-unloaded')
      const plistPath = await writeAgentPlist({
        HRC_RUNTIME_DIR: runtimeDir,
        HRC_MAIL_KICKER_ENABLED: '1',
        HRC_WRKQ_DB: 'rpc://127.0.0.1:7171',
        LANG: 'en_US.UTF-8',
      })
      process.env.HOME = home as string
      process.env.HRC_RUNTIME_DIR = runtimeDir
      shim = await writeShim({ exitCode: 113 })
      process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

      const stranded = await detectStrandedLaunchAgent()
      expect(stranded).not.toBeNull()
      expect(stranded?.label).toBe(LABEL)
      expect(stranded?.plistPath).toBe(plistPath)
      expect(stranded?.serviceTarget).toBe(`${stranded?.domain}/${LABEL}`)
      // Only HRC_* keys, sorted; LANG is the daemon's locale, not its wiring.
      expect(stranded?.declaredEnvKeys).toEqual([
        'HRC_MAIL_KICKER_ENABLED',
        'HRC_RUNTIME_DIR',
        'HRC_WRKQ_DB',
      ])
    }
  )

  // The governance rule. A `hrc dev env` or test daemon runs on its own runtime
  // root while the operator's plist sits in ~/Library/LaunchAgents; gating those
  // would break every isolated daemon on the box.
  it.if(IS_DARWIN)('returns null when the plist governs a different runtime root', async () => {
    await writeAgentPlist({ HRC_RUNTIME_DIR: join(tmpdir(), 'operator-runtime') })
    process.env.HOME = home as string
    process.env.HRC_RUNTIME_DIR = join(tmpdir(), 'hrc-dev-env-502-abc')
    shim = await writeShim({ exitCode: 113 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

    expect(await detectStrandedLaunchAgent()).toBeNull()
  })

  it.if(IS_DARWIN)(
    'treats a plist with no declared runtime dir as governing only the default root',
    async () => {
      await writeAgentPlist(null)
      process.env.HOME = home as string
      shim = await writeShim({ exitCode: 113 })
      process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

      process.env.HRC_RUNTIME_DIR = join(tmpdir(), 'some-other-root')
      expect(await detectStrandedLaunchAgent()).toBeNull()

      setEnv('HRC_RUNTIME_DIR', undefined)
      const stranded = await detectStrandedLaunchAgent()
      expect(stranded).not.toBeNull()
      expect(stranded?.declaredEnvKeys).toEqual([])
    }
  )
})

describe('formatStrandedLaunchAgentRefusal', () => {
  const agent = {
    label: 'com.praesidium.hrc-server',
    plistPath: '/Users/lherron/Library/LaunchAgents/com.praesidium.hrc-server.plist',
    serviceTarget: 'gui/501/com.praesidium.hrc-server',
    domain: 'gui/501',
    declaredEnvKeys: ['HRC_MAIL_KICKER_ENABLED', 'HRC_WRKQ_DB'] as const,
  }

  it('names the action, the missing environment, and the exact repair', () => {
    const message = formatStrandedLaunchAgentRefusal(agent, 'restart')
    expect(message).toContain('refusing to restart an unsupervised daemon')
    expect(message).toContain(agent.plistPath)
    expect(message).toContain('HRC_MAIL_KICKER_ENABLED, HRC_WRKQ_DB')
    expect(message).toContain(`launchctl bootstrap ${agent.domain} ${agent.plistPath}`)
    expect(message).toContain('T-07957')
  })

  it('names the start action when start is what was refused', () => {
    expect(formatStrandedLaunchAgentRefusal(agent, 'start')).toContain(
      'refusing to start an unsupervised daemon'
    )
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
  it('schedules bounded state retention nightly without full VACUUM or KeepAlive', async () => {
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
    expect(plist).toContain('<string>--runtime-buffer-retention-days</string>')
    // Non-delta events retain indefinitely (Lance ruling 2026-07-28): the
    // scheduled job must prune runtime_buffers only, never age out event rows.
    expect(plist).toContain('<string>--tables</string>')
    expect(plist).toContain('<string>runtime_buffers</string>')
    expect(plist).not.toContain('<string>--event-retention-days</string>')
    expect(plist).not.toContain('<string>events</string>')
    expect(plist).not.toContain('<string>hrc_events</string>')
    expect(plist).not.toContain('<string>broker_invocation_events</string>')
    expect(plist).toContain(
      '<string>--incremental-vacuum-pages</string>\n\t\t<string>20000</string>'
    )
    // Writer-lock guards: the job shares state.sqlite with the live daemon.
    expect(plist).toContain('<string>--deadline-minutes</string>')
    expect(plist).toContain('<string>--pace-millis</string>')
    expect(plist).toContain('<string>--max-write-hold-millis</string>')
    expect(plist).toContain('<string>--max-duty-cycle</string>')
    expect(plist).toContain('<string>--incremental-vacuum-chunk-pages</string>')
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

  it.if(IS_DARWIN)('reports success without a failure message when launchctl exits 0', async () => {
    shim = await writeShim({ exitCode: 0 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

    const result = await launchctlKickstart({
      label: 'com.example.hrc',
      domain: 'gui/501',
      serviceTarget: 'gui/501/com.example.hrc',
    })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.benign).toBe(false)
    expect(result.message).toBe('')
  })

  // Regression (T-07580): EALREADY means launchd was already restarting the
  // job, so the actuation happened. Classifying it as a hard failure produced a
  // false RED on `hrc server restart` for a restart that had in fact succeeded.
  it.if(IS_DARWIN)('classifies EALREADY (37) as a benign already-in-progress race', async () => {
    shim = await writeShim({ exitCode: LAUNCHCTL_EALREADY })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

    const result = await launchctlKickstart(
      {
        label: 'com.example.hrc',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.example.hrc',
      },
      { kill: true }
    )

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(LAUNCHCTL_EALREADY)
    expect(result.benign).toBe(true)
    expect(result.message).toContain('already in progress')
  })

  it.if(IS_DARWIN)('classifies any other non-zero status as a real failure', async () => {
    shim = await writeShim({ exitCode: 113 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

    const result = await launchctlKickstart({
      label: 'com.example.hrc',
      domain: 'gui/501',
      serviceTarget: 'gui/501/com.example.hrc',
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(113)
    expect(result.benign).toBe(false)
    expect(result.message).toContain('launchctl kickstart failed (exit 113)')
  })

  // The whole point of returning a result: a non-zero status must never end the
  // process, because only observing the daemon can establish the outcome.
  it.if(IS_DARWIN)('never exits or throws on a non-zero status', async () => {
    shim = await writeShim({ exitCode: 113 })
    process.env.PATH = `${shim.dir}:${originalPath ?? ''}`

    await expect(
      launchctlKickstart({
        label: 'com.example.hrc',
        domain: 'gui/501',
        serviceTarget: 'gui/501/com.example.hrc',
      })
    ).resolves.toBeDefined()
  })
})
