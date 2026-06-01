import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import type { HrcServerOptions } from './server-types.js'
import { requireTmuxPane } from './require-helpers.js'

const MIN_SUPPORTED_TMUX_VERSION = {
  major: 3,
  minor: 2,
}

export function getTmuxSocketPath(options: HrcServerOptions): string {
  return options.tmuxSocketPath ?? join(options.runtimeRoot, 'tmux.sock')
}

export function getBrokerTmuxSocketPath(
  options: HrcServerOptions,
  brokerDriver: string,
  runtimeId: string
): string {
  const driver = sanitizeBrokerTmuxPathSegment(brokerDriver).slice(0, 12)
  const runtime = sanitizeBrokerTmuxPathSegment(runtimeId).slice(0, 32)
  return join(options.runtimeRoot, 'btmux', `${driver}-${runtime}.sock`)
}

export function sanitizeBrokerTmuxPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

export async function detectTmuxBackend(): Promise<{ available: boolean; version?: string | undefined }> {
  try {
    const proc = Bun.spawn(['tmux', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const version = parseTmuxVersion(stdout, stderr)
    const available =
      exitCode === 0 &&
      (version.major > MIN_SUPPORTED_TMUX_VERSION.major ||
        (version.major === MIN_SUPPORTED_TMUX_VERSION.major &&
          version.minor >= MIN_SUPPORTED_TMUX_VERSION.minor))
    return {
      available,
      version: version.raw,
    }
  } catch {
    return { available: false }
  }
}

export function parseTmuxVersion(
  stdout: string,
  stderr: string
): { major: number; minor: number; raw: string } {
  const source = `${stdout}\n${stderr}`.trim()
  const match = source.match(/tmux\s+(\d+)\.(\d+(?:[a-z])?)/i)
  if (!match) {
    throw new Error(`unable to parse tmux version from output: ${source || '<empty>'}`)
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt((match[2] ?? '0').replace(/[^0-9].*$/, ''), 10),
    raw: `${match[1]}.${match[2]}`,
  }
}

export function getTmuxSessionName(runtime: HrcRuntimeSnapshot): string {
  return requireTmuxPane(runtime).sessionName
}
