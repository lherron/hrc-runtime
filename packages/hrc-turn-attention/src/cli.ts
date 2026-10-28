#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './subscriber.js'

if (process.argv.includes('--help')) {
  console.log(
    'hrc-turn-attention: follows local HRC turn ends; requires TYPESAFE_API_KEY. Optional HRC_SOCKET_PATH and HRC_TURN_ATTENTION_STATE_PATH.'
  )
} else {
  const key = process.env['TYPESAFE_API_KEY']
  if (!key) throw new Error('TYPESAFE_API_KEY is required')
  try {
    await run(
      process.env['HRC_SOCKET_PATH'] ?? join(homedir(), 'praesidium/var/run/hrc/hrc.sock'),
      process.env['HRC_TURN_ATTENTION_STATE_PATH'] ??
        join(homedir(), 'praesidium/var/state/turn-attention/cursor.json'),
      key
    )
  } catch (error) {
    // HRC restarted or is unreachable: exit for launchd to restart us from the
    // persisted cursor, leaving one JSON line instead of a raw stack trace.
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: 'error', component: 'hrc-turn-attention', event: 'turn_attention.exited', data: { error: String(error) } })}\n`
    )
    process.exit(1)
  }
}
