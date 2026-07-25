import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { TurnAdmissionGate, turnAdmissionMarkerPath } from '../turn-admission-gate.js'

async function withRuntimeRoot(run: (runtimeRoot: string) => Promise<void>): Promise<void> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'hrc-turn-admission-'))
  try {
    await run(runtimeRoot)
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true })
  }
}

describe('TurnAdmissionGate', () => {
  it('closes before its durability await and waits for every prior admission to leave', async () => {
    await withRuntimeRoot(async (runtimeRoot) => {
      const gate = new TurnAdmissionGate(runtimeRoot)
      const release = gate.admit()
      let settled = false
      const closing = gate
        .close({
          operationId: 'restart-1',
          requestedBy: 'agent:cody:project:hrc-runtime:task:primary/lane:main',
        })
        .then((value) => {
          settled = true
          return value
        })

      await Bun.sleep(10)
      expect(settled).toBe(false)
      expect(gate.snapshot()).toMatchObject({
        state: 'closed',
        activeAdmissions: 1,
        operationId: 'restart-1',
        durable: true,
      })
      expect(() => gate.admit()).toThrow(HrcDomainError)
      try {
        gate.admit()
      } catch (error) {
        expect(error).toMatchObject({
          code: HrcErrorCode.SERVER_DRAINING,
          status: 503,
          detail: { retryable: true, operationId: 'restart-1' },
        })
      }

      release()
      expect(await closing).toMatchObject({
        state: 'closed',
        activeAdmissions: 0,
        operationId: 'restart-1',
        durable: true,
      })
    })
  })

  it('makes close idempotent for its owner and fences a different reopen operation', async () => {
    await withRuntimeRoot(async (runtimeRoot) => {
      const gate = new TurnAdmissionGate(runtimeRoot)
      await gate.close({ operationId: 'restart-1' })
      expect(await gate.close({ operationId: 'restart-1' })).toMatchObject({
        state: 'closed',
        operationId: 'restart-1',
      })
      await expect(gate.reopen('restart-2')).rejects.toMatchObject({
        code: HrcErrorCode.STALE_CONTEXT,
        detail: {
          requestedOperationId: 'restart-2',
          activeOperationId: 'restart-1',
        },
      })
      expect(await gate.reopen('restart-1')).toEqual({
        state: 'open',
        activeAdmissions: 0,
        durable: false,
      })
      expect(await Bun.file(turnAdmissionMarkerPath(runtimeRoot)).exists()).toBe(false)
    })
  })

  it('starts a replacement daemon closed and reopens only when startup owns recovery', async () => {
    await withRuntimeRoot(async (runtimeRoot) => {
      const priorDaemon = new TurnAdmissionGate(runtimeRoot)
      await priorDaemon.close({
        operationId: 'restart-persisted',
        requestedRunId: 'run-caller',
        reason: 'test restart',
      })

      const replacementDaemon = new TurnAdmissionGate(runtimeRoot)
      expect(replacementDaemon.snapshot()).toMatchObject({
        state: 'closed',
        operationId: 'restart-persisted',
        requestedRunId: 'run-caller',
        durable: true,
      })
      expect(() => replacementDaemon.admit()).toThrow(
        'server turn admission is closed for a drained restart'
      )

      expect(await replacementDaemon.reopen()).toEqual({
        state: 'open',
        activeAdmissions: 0,
        durable: false,
      })
      const release = replacementDaemon.admit()
      release()
    })
  })

  it('allows only already-durable accepted work to settle while closed', async () => {
    await withRuntimeRoot(async (runtimeRoot) => {
      const gate = new TurnAdmissionGate(runtimeRoot)
      await gate.close({ operationId: 'restart-existing-work' })

      expect(() => gate.admit()).toThrow(HrcDomainError)
      const release = gate.admit({ existingAcceptedRun: true })
      expect(gate.snapshot().activeAdmissions).toBe(1)
      release()
      expect(gate.snapshot().activeAdmissions).toBe(0)
    })
  })
})
