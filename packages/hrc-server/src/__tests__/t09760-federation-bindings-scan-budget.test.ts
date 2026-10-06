/**
 * T-09760 — GET /v1/federation/bindings held open for 9-11 minutes.
 *
 * Organic evidence (max3, 2026-10-05 20:32-20:46Z): the route resolves declared
 * placement policy once per active binding, serially (3,556 bindings). Against
 * a cold aspd, four overlapping `hrc doctor` reads each ran the full scan: aspd
 * answered 15,211 declaration resolves in that window at p90 55.7ms / p99 227ms
 * (warm: p90 0.7ms), and each read took 556-657s, any of which would pin the
 * stop drain.
 *
 * Production route, real fixture daemon; only `policyFor` (the per-binding
 * resolver the route already exposes as a seam) is slowed or hung.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { LocateBindingsReport } from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import type { PlacementPolicyResolution } from '../federation/placement-policy'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const BUDGET_MS = 400
const BINDINGS = 40
const PER_BINDING_MS = 50

type Inspectable = HrcServer & {
  policyFor?: (scopeRef: string) => Promise<PlacementPolicyResolution>
  bindingsScanBudgetMs?: number
}

let fixture: HrcServerTestFixture
let server: Inspectable | undefined
let stderr: string[]
let restoreStderr: () => void

const scopeAt = (index: number) => `agent:clod:project:hrc-runtime:task:T-09760-b${index}`

const RESOLVED: PlacementPolicyResolution = {
  outcome: 'resolved',
  profilePath: '/tmp/agent-profile.toml',
  policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
}

function seedBindings(count: number): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const ledger = createPlacementLedgerRepository(db.sqlite)
    for (let index = 0; index < count; index += 1) {
      ledger.installActive({
        scopeRef: scopeAt(index),
        homeNodeId: 'max3',
        updatedAt: new Date().toISOString(),
      })
    }
  } finally {
    db.close()
  }
}

function logLines(event: string): Array<Record<string, unknown>> {
  return stderr
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.includes(` ${event} `))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>)
}

async function readBindings(): Promise<{ report: LocateBindingsReport; elapsedMs: number }> {
  const startedAt = performance.now()
  const res = await fixture.fetchSocket('/v1/federation/bindings', {
    signal: AbortSignal.timeout(10_000),
  })
  expect(res.status).toBe(200)
  return {
    report: (await res.json()) as LocateBindingsReport,
    elapsedMs: performance.now() - startedAt,
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t09760-bind-')
  stderr = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  restoreStderr = () => {
    process.stderr.write = original
  }
  server = (await createHrcServer(
    fixture.serverOpts({ otelListenerEnabled: false })
  )) as Inspectable
  server.bindingsScanBudgetMs = BUDGET_MS
  seedBindings(BINDINGS)
})

afterEach(async () => {
  restoreStderr()
  if (server) await server.stop().catch(() => undefined)
  server = undefined
  await fixture.cleanup()
})

describe('T-09760 GET /v1/federation/bindings is bounded', () => {
  it('a slow serial scan stops at its budget and names the slowest bindings', async () => {
    server!.policyFor = async () => {
      await Bun.sleep(PER_BINDING_MS)
      return RESOLVED
    }

    const { report, elapsedMs } = await readBindings()

    // Unbounded, this read takes BINDINGS * PER_BINDING_MS = 2s+.
    expect(elapsedMs).toBeLessThan(BUDGET_MS + 300)
    expect(report.scan.truncated).toMatchObject({ budgetMs: BUDGET_MS })
    expect(report.scan.scanned + (report.scan.truncated?.notAssessed ?? 0)).toBe(BINDINGS)
    expect(report.scan.scanned).toBeGreaterThan(0)

    const [line] = logLines('federation.bindings.scan_truncated')
    expect(line).toMatchObject({
      budgetMs: BUDGET_MS,
      scanned: report.scan.scanned,
      inFlightScopeRef: report.scan.truncated?.inFlightScopeRef,
    })
    // The ledger lists in its own order, so which bindings were reached varies;
    // every one it names was resolved and carries its real cost.
    const slowest = line?.['slowest'] as Array<{ scopeRef: string; ms: number }>
    expect(slowest.length).toBe(Math.min(5, report.scan.scanned))
    for (const entry of slowest) {
      expect(entry.scopeRef).toStartWith('agent:clod:project:hrc-runtime:task:T-09760-b')
      expect(entry.ms).toBeGreaterThanOrEqual(PER_BINDING_MS - 5)
    }
  })

  it('a binding whose policy never resolves is named, and the read still answers', async () => {
    server!.policyFor = async (scopeRef) =>
      scopeRef === scopeAt(5) ? new Promise(() => undefined) : RESOLVED

    const { report, elapsedMs } = await readBindings()

    expect(elapsedMs).toBeLessThan(BUDGET_MS + 300)
    expect(report.scan.truncated?.inFlightScopeRef).toBe(scopeAt(5))
    expect(logLines('federation.bindings.scan_truncated')[0]?.['inFlightScopeRef']).toBe(scopeAt(5))
  })

  it('a fast scan is unchanged: complete, no truncation, no warning', async () => {
    server!.policyFor = async () => RESOLVED
    const { report } = await readBindings()
    expect(report.scan.scanned).toBe(BINDINGS)
    expect(report.scan.truncated).toBeUndefined()
    expect(logLines('federation.bindings.scan_truncated')).toEqual([])
    expect(logLines('federation.bindings.scan_slow')).toEqual([])
  })

  it('concurrent reads share one scan instead of each resolving every binding', async () => {
    let resolutions = 0
    server!.policyFor = async () => {
      resolutions += 1
      await Bun.sleep(2)
      return RESOLVED
    }
    server!.bindingsScanBudgetMs = 10_000

    const reports = await Promise.all([
      readBindings(),
      readBindings(),
      readBindings(),
      readBindings(),
    ])

    for (const { report } of reports) expect(report.scan.scanned).toBe(BINDINGS)
    expect(resolutions).toBe(BINDINGS)
  })
})
