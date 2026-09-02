import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { HrcErrorCode } from 'hrc-core'

import { brokerCapabilitiesSupportAdmissionClass } from '../broker/capabilities.js'

const source = (name: string) => readFileSync(join(import.meta.dir, '..', name), 'utf8')

describe('broker admission gates after the class-specific ABI', () => {
  it('preserves descriptor-absent and ask-client fail-closed machine codes', () => {
    expect(HrcErrorCode.BROKER_DESCRIPTOR_ABSENT).toBe('broker_descriptor_absent')
    expect(HrcErrorCode.ASK_CLIENT_UNSUPPORTED).toBe('ask_client_unsupported')
  })

  it('does not derive class support from busy/run state', () => {
    expect(brokerCapabilitiesSupportAdmissionClass(undefined, 'queue')).toBe(false)
    expect(brokerCapabilitiesSupportAdmissionClass('{not-json', 'queue')).toBe(false)
  })

  it('admits only broker-advertised classes', () => {
    const capabilities = JSON.stringify({ admission: { classes: ['queue', 'exclusive'] } })
    expect(brokerCapabilitiesSupportAdmissionClass(capabilities, 'queue')).toBe(true)
    expect(brokerCapabilitiesSupportAdmissionClass(capabilities, 'exclusive')).toBe(true)
    expect(brokerCapabilitiesSupportAdmissionClass(capabilities, 'steer')).toBe(false)
    expect(brokerCapabilitiesSupportAdmissionClass(capabilities, 'preempt')).toBe(false)
  })

  it('preempt authority is checked before the broker syscall and cannot upgrade another door', () => {
    const handlers = source('turn-dispatch-handlers.ts')
    const authority = handlers.indexOf('async function preemptAuthorized')
    const syscall = handlers.indexOf("door === 'preempt' &&", authority)
    expect(authority).toBeGreaterThan(-1)
    expect(syscall).toBeGreaterThan(authority)
    expect(handlers).toContain("reason: 'authority-denied'")
  })
})
