/**
 * T-08566 stage-2 retained-reader fixture.
 *
 * The immutable reader responses in ./t08566-real-reader-responses are byte
 * copies of the compiled asp-f450dc99 release. Error-mode responses are
 * mechanically derived from those captures here; no producer error body is
 * invented by these tests. The wrapper also records argv, stdin and the exact
 * environment offered by HRC, and can block on a sentinel for ownership races.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcServerTestFixture } from './hrc-test-fixture'

export type ReaderMode =
  | 'full'
  | 'small-bytes'
  | 'unknown-invocation'
  | 'after-beyond-current'
  | 'release-mismatch'
  | 'nonprogress'
  | 'snapshot-change'
  | 'overflow'
  | 'exit-one'
  | 'timeout'
  | 'torn'
  | 'corrupt'
  | 'duplicate'
  | 'oversize'
  | 'below-floor'

export type ReaderDouble = {
  release: Record<string, unknown>
  root: string
  executable: string
  recordPath: string
  unblockPath: string
}

export type OfflineRuntime = {
  runtimeId: string
  invocationId: string
  ledgerPath: string
  indexPath: string
  reader: ReaderDouble
}

const CAPTURES = join(import.meta.dir, 't08566-real-reader-responses')

export async function capturedReaderResponse(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(CAPTURES, name), 'utf8')) as Record<string, unknown>
}

export async function deriveReaderResponse(mode: ReaderMode): Promise<string> {
  const exactCapture: Partial<Record<ReaderMode, string>> = {
    torn: 'torn.stdout.json',
    corrupt: 'corrupt.stdout.json',
    duplicate: 'duplicate.stdout.json',
    oversize: 'oversize.stdout.json',
    'below-floor': 'below-floor.stdout.json',
    'unknown-invocation': 'wrong-invocation.stdout.json',
    'after-beyond-current': 'after-beyond-current.stdout.json',
  }
  const sourceName =
    exactCapture[mode] ??
    (mode === 'small-bytes' || mode === 'nonprogress' || mode === 'snapshot-change'
      ? 'small-bytes.stdout.json'
      : 'full.stdout.json')
  const captured = await capturedReaderResponse(sourceName)
  if (mode === 'release-mismatch') {
    captured['release'] = {
      ...(captured['release'] as object),
      releaseId: 'asp-derived-mismatch',
    }
  } else if (mode === 'nonprogress') {
    captured['hasMore'] = true
    captured['nextAfterSeq'] = 0
  } else if (mode === 'snapshot-change') {
    const snapshot = captured['snapshot'] as { ledger?: Record<string, unknown> }
    snapshot.ledger = {
      ...snapshot.ledger,
      mtimeMs: Number(snapshot.ledger?.['mtimeMs'] ?? 0) + 1,
    }
  }
  const body = `${JSON.stringify(captured)}\n`
  return mode === 'overflow' ? `${body}${'x'.repeat(5 * 1024 * 1024)}` : body
}

export async function makeOfflineReaderDouble(
  root: string,
  mode: ReaderMode,
  opts: { capability?: boolean; releaseId?: string } = {}
): Promise<ReaderDouble> {
  const releaseId = opts.releaseId ?? 'asp-f450dc999924-test'
  const releaseRoot = join(root, releaseId)
  const executable = join(releaseRoot, 'harness-broker')
  const responsePath = join(releaseRoot, 'response.json')
  const recordPath = join(releaseRoot, 'reader-invocation.json')
  const unblockPath = join(releaseRoot, 'unblock')
  await mkdir(releaseRoot, { recursive: true })
  await writeFile(responsePath, await deriveReaderResponse(mode))
  const sourceCommit = 'f450dc9999240000000000000000000000000000'
  await writeFile(
    join(releaseRoot, 'release.json'),
    JSON.stringify({
      releaseId,
      sourceCommit,
      builtAt: '2026-09-17T05:40:56.000Z',
      capabilities: opts.capability === false ? [] : ['offline-evidence-read/v1'],
    })
  )
  const script = `#!/bin/sh
set -eu
stdin=$(mktemp)
cat > "$stdin"
env | LC_ALL=C sort > "${recordPath}.env"
printf '{"argv":' > "${recordPath}"
printf '%s\\n' "$@" | python3 -c 'import json,sys; print(json.dumps([x.rstrip("\\n") for x in sys.stdin]))' >> "${recordPath}"
printf ',"stdin":' >> "${recordPath}"
python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "$stdin" >> "${recordPath}"
printf '}\\n' >> "${recordPath}"
${mode === 'timeout' ? `while [ ! -e "${unblockPath}" ]; do sleep 0.05; done` : ''}
${
  mode === 'overflow'
    ? `cat "${responsePath}"`
    : `python3 - "$stdin" "${responsePath}" "${mode}" <<'PY'
import json, sys
request = json.load(open(sys.argv[1]))
response = json.load(open(sys.argv[2]))
mode = sys.argv[3]
after = int(request.get('afterSeq', 0))
invocation = request.get('invocationId')
events = response.get('result', {}).get('events', [])
for index, event in enumerate(events, 1):
    if invocation:
        event['invocationId'] = invocation
    if mode in ('small-bytes', 'snapshot-change'):
        event['seq'] = after + index
if mode in ('small-bytes', 'snapshot-change'):
    current = 72 if mode == 'small-bytes' else 36
    response['result']['currentSeq'] = current
    response['hasMore'] = after + len(events) < current
    response['nextAfterSeq'] = after + len(events)
if mode == 'snapshot-change' and after > 0:
    response['snapshot']['ledger']['mtimeMs'] += 1
print(json.dumps(response, separators=(',', ':')))
PY`
}
exit ${mode === 'exit-one' ? 1 : 0}
`
  await writeFile(executable, script)
  await chmod(executable, 0o755)
  return {
    root: releaseRoot,
    executable,
    recordPath,
    unblockPath,
    release: {
      source: 'aspd',
      releaseId,
      sourceCommit,
      builtAt: '2026-09-17T05:40:56.000Z',
      releaseRoot,
      worker: { protocol: 'harness-broker/0.2', executable, argvPrefix: [] },
    },
  }
}

/** Seed the complete persisted graph the stage-2 HTTP seam must consume. */
export async function seedOfflineRuntime(
  fixture: HrcServerTestFixture,
  mode: ReaderMode,
  opts: { lastProjectedSeq?: number; capability?: boolean; status?: string } = {}
): Promise<OfflineRuntime> {
  const suffix = `${mode}-${Math.random().toString(16).slice(2)}`
  const runtimeId = `rt-${suffix}`
  const invocationId = `inv-${suffix}`
  const operationId = `op-${suffix}`
  const hostSessionId = `hsid-${suffix}`
  const scopeRef = `agent:smokey:project:hrc-runtime:task:T-08566-${suffix}`
  const reader = await makeOfflineReaderDouble(fixture.tmpDir, mode, {
    ...(opts.capability === undefined ? {} : { capability: opts.capability }),
  })
  const ledgerDir = join(fixture.runtimeRoot, 'bipc', runtimeId)
  const ledgerPath = join(ledgerDir, 'events.ndjson')
  const indexPath = join(ledgerDir, 'ledger-index.db')
  const socketPath = join(ledgerDir, 'missing.sock')
  const tokenPath = join(ledgerDir, 'attach.token')
  await mkdir(ledgerDir, { recursive: true })
  await writeFile(ledgerPath, '')
  await writeFile(indexPath, 't08566-index-sentinel')
  fixture.seedSession(hostSessionId, scopeRef)
  fixture.seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, {
    status: opts.status ?? 'terminated',
  })
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.runtimes.update(runtimeId, {
      controllerKind: 'harness-broker',
      activeInvocationId: invocationId,
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId,
        hostSessionId,
        generation: 1,
        status: opts.status ?? 'terminated',
        executionRelease: reader.release,
        broker: {
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            socketPath,
            attachTokenRef: { kind: 'file', path: tokenPath, redacted: true },
            protocolVersion: 'harness-broker/0.2',
          },
          substrate: {
            kind: 'leased-tmux',
            tmuxSocketPath: fixture.tmuxSocketPath,
            sessionName: `hrc-${runtimeId}`,
            brokerWindow: { sessionId: '$dead', windowId: '@dead', paneId: '%dead' },
            generation: 1,
            eventLedgerPath: ledgerPath,
          },
          presentation: { kind: 'none' },
        },
      },
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId: invocationId as never,
      operationId,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-desktop',
      invocationState: 'exited',
      capabilitiesJson: JSON.stringify({ offlineEvidence: true }),
      specHash: 'sha256:t08566-spec',
      startRequestHash: 'sha256:t08566-start',
      selectedProfileHash: 'sha256:t08566-profile',
      lastProjectedSeq: opts.lastProjectedSeq ?? 0,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
  return { runtimeId, invocationId, ledgerPath, indexPath, reader }
}

export function columnNames(sqlite: { query<T, P extends unknown[]>(sql: string): { all(...p: P): T[] } }, table: string): string[] {
  return sqlite
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)
}
