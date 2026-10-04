import { describe, expect, it } from 'bun:test'
import { RUNTIME_STATUS_VALUES } from 'spaces-runtime-contracts'
import {
  isRunTerminal,
  parseHrcRunStatus,
  parseHrcRuntimeStatus,
  parseHrcSessionStatus,
} from '../status-contracts.js'

describe('durable status contracts', () => {
  it('reads the ASP runtime vocabulary and HRC legacy values without losing identity', () => {
    for (const status of [...RUNTIME_STATUS_VALUES, 'idle', 'running', 'exited']) {
      expect(parseHrcRuntimeStatus(status)).toBe(status)
    }
  })

  it('rejects unknown values instead of manufacturing a valid status', () => {
    for (const parse of [parseHrcRuntimeStatus, parseHrcRunStatus, parseHrcSessionStatus]) {
      expect(() => parse('future-status')).toThrow()
      expect(() => parse(undefined)).toThrow()
    }
  })

  it('classifies all known run terminal outcomes, including legacy and coalesced rows', () => {
    for (const status of [
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'degraded',
      'zombie',
      'reaped',
      'coalesced',
      'exited',
    ]) {
      expect(isRunTerminal({ status: parseHrcRunStatus(status) })).toBe(true)
    }
    for (const status of ['queued', 'accepted', 'started', 'running', 'awaiting_permission']) {
      expect(isRunTerminal({ status: parseHrcRunStatus(status) })).toBe(false)
    }
  })

  it('preserves active and archived sessions', () => {
    expect(parseHrcSessionStatus('active')).toBe('active')
    expect(parseHrcSessionStatus('archived')).toBe('archived')
  })
})
