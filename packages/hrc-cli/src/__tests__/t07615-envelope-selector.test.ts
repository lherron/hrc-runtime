import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliUsageError } from 'cli-kit'

import {
  isEnvelopeSelector,
  resolveEnvelopeSelectors,
  wrkqEnvelopeShow,
} from '../monitor/envelope-selector.js'

/**
 * `hrc monitor watch EN-xxxxx` (T-07612 §7, T-07615).
 *
 * An envelope id is a wrkq row id and wrkq has no idea what a run is. The join
 * is the presentation receipt HRC itself wrote, so the selector resolves through
 * `presented_to` to the runtime the envelope was injected into.
 */

function ledger(envelope: unknown): (id: string) => Promise<unknown> {
  return async () => envelope
}

describe('T-07615 — hrc monitor watch EN-xxxxx', () => {
  it('recognizes EN ids and leaves every other selector alone', () => {
    expect(isEnvelopeSelector('EN-00042')).toBe(true)
    expect(isEnvelopeSelector('  EN-00042 ')).toBe(true)
    // EV- belongs to evidence items, not envelopes (T-07612 C-16371).
    expect(isEnvelopeSelector('EV-00042')).toBe(false)
    expect(isEnvelopeSelector('T-07615')).toBe(false)
    expect(isEnvelopeSelector('runtime:rt-1')).toBe(false)
  })

  it('resolves to the runtime named by the NEWEST presentation receipt', async () => {
    const resolved = await resolveEnvelopeSelectors(
      ['EN-00042'],
      ledger({
        presentedTo: [
          { runtimeId: 'rt-old', runId: 'run-old', presentedAt: '2026-08-27T10:00:00Z' },
          { runtimeId: 'rt-new', runId: 'run-new', presentedAt: '2026-08-27T11:00:00Z' },
        ],
      })
    )
    expect(resolved).toEqual(['runtime:rt-new'])
  })

  it('falls back to the run when a receipt names no runtime', async () => {
    const resolved = await resolveEnvelopeSelectors(
      ['EN-00042'],
      ledger({ presentedTo: [{ runId: 'run-only', presentedAt: '2026-08-27T10:00:00Z' }] })
    )
    expect(resolved).toEqual(['run:run-only'])
  })

  it('passes non-envelope selectors through untouched', async () => {
    const resolved = await resolveEnvelopeSelectors(['T-07615', 'runtime:rt-1'], async () => {
      throw new Error('the ledger must not be consulted for these')
    })
    expect(resolved).toEqual(['T-07615', 'runtime:rt-1'])
  })

  it('says plainly that an unpresented envelope has no turn to watch', async () => {
    const attempt = resolveEnvelopeSelectors(['EN-00042'], ledger({ presentedTo: [] }))
    await expect(attempt).rejects.toBeInstanceOf(CliUsageError)
    await expect(attempt).rejects.toThrow('has not been presented yet')
    // And it names the surface that DOES answer for a pending envelope.
    await expect(attempt).rejects.toThrow('wrkc show EN-00042')
  })

  it('reports a ledger failure as a usage error rather than a crash', async () => {
    const attempt = resolveEnvelopeSelectors(['EN-00042'], async () => {
      throw new Error('wrkqd is unreachable')
    })
    await expect(attempt).rejects.toThrow('could not resolve EN-00042')
  })

  // T-10244: the one-shot `wrkq rpc --stdio` read is bounded.
  it('refuses, naming the bound, when wrkq outlives it', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'slow-wrkq-'))
    const wrkq = join(bin, 'wrkq')
    writeFileSync(wrkq, '#!/bin/sh\n/bin/sleep 30\n')
    chmodSync(wrkq, 0o755)
    const startedAt = performance.now()
    try {
      const attempt = resolveEnvelopeSelectors(
        ['EN-00042'],
        wrkqEnvelopeShow(200, { ...process.env, PATH: bin })
      )
      await expect(attempt).rejects.toThrow('exceeded 200ms')
      expect(performance.now() - startedAt).toBeLessThan(2_000)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
