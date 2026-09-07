#!/usr/bin/env bun
import { Command } from 'commander'
import { installCliMetricsRecorder } from 'hrc-core'

import { HRCCHAT_REDIRECT } from './redirect.js'

export const program = new Command().name('hrcchat').description('retired; use wrkc')

export async function runCli(): Promise<void> {
  const metrics = installCliMetricsRecorder({ bin: 'hrcchat', argv: process.argv })
  metrics.setCommandTree(program)
  process.stderr.write(HRCCHAT_REDIRECT)
  process.exitCode = 2
}

if (import.meta.main) {
  await runCli()
}
