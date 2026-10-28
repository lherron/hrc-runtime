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
  await run(
    process.env['HRC_SOCKET_PATH'] ?? join(homedir(), 'praesidium/var/run/hrc/hrc.sock'),
    process.env['HRC_TURN_ATTENTION_STATE_PATH'] ??
      join(homedir(), 'praesidium/var/state/turn-attention/cursor.json'),
    key
  )
}
