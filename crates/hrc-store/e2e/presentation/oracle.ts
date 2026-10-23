import { realpathSync, writeSync } from 'node:fs'
/** Real unchanged producer + unchanged presentation functions; scratch only. */
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const emit = async (value: unknown) => {
  const data = Buffer.from(`${JSON.stringify(value)}\n`)
  let offset = 0
  while (offset < data.length) {
    try {
      offset += writeSync(1, data, offset, data.length - offset)
    } catch (e: any) {
      if (e.code !== 'EAGAIN') throw e
      await new Promise((r) => setTimeout(r, 1))
    }
  }
}
const [release, root, mode] = process.argv.slice(2)
if (!/^\/(private\/)?tmp\/hrcp1-presentation-/.test(realpathSync(root)))
  throw Error('scratch required')
const source = resolve(release)
const { openHrcDatabase } = await import(
  pathToFileURL(join(source, 'packages/hrc-store-sqlite/src/index.ts')).href
)
const { handleReadPresentationSeats, projectPresentationRuntime } = await import(
  pathToFileURL(join(source, 'packages/hrc-server/src/presentation-read-model.ts')).href
)
const db = openHrcDatabase(join(root, 'state.sqlite'), { migrate: mode === 'seed' })
const old = '2026-09-01T00:00:00.000Z'
const since = '2026-10-22T00:00:00.000Z'
const now = '2026-10-23T00:00:00.000Z'
const scope = (n: string) => `agent:present:project:hrc-runtime:task:${n}`
const window = { sessionId: '$1', windowId: '@2', paneId: '%3' }
const hosting = {
  endpoint: { kind: 'stdio-jsonrpc-ndjson' },
  substrate: {
    kind: 'leased-tmux',
    tmuxSocketPath: '/stored/socket',
    sessionName: 'stored-session',
    brokerWindow: window,
    generation: 1,
  },
  presentation: { kind: 'tmux-tui', tuiWindow: window },
}
function session(n: string, g = 1, at = old, lane = 'main') {
  const host = `present-${n}-${g}`
  db.sessions.insert({
    hostSessionId: host,
    scopeRef: scope(n),
    laneRef: lane,
    generation: g,
    status: 'inactive',
    createdAt: at,
    updatedAt: now,
  })
  return host
}
function runtime(n: string, host: string, g = 1, status = 'ready', extra: any = {}) {
  db.runtimes.insert({
    runtimeId: `present-${n}`,
    hostSessionId: host,
    scopeRef: scope(n.replace(/-second$/, '')),
    laneRef: 'main',
    generation: g,
    transport: 'tmux',
    status,
    supportsInflightInput: false,
    createdAt: old,
    updatedAt: now,
    ...extra,
  })
}
const refs = [
  ...Array.from({ length: 270 }, (_, i) => `${scope(`bulk${i}`)}/lane:main`),
  `${scope('quiet')}/lane:main`,
  `${scope('recent')}/lane:main`,
  `${scope('boundary')}/lane:main`,
  `${scope('outside')}/lane:main`,
  `${scope('fallback')}/lane:main`,
  `${scope('active')}/lane:main`,
  `${scope('absent')}/lane:main`,
  `${scope('alternate')}/lane:alt`,
  `${scope('alternate')}/lane:lane:alt`,
  `${scope('quiet')}/lane:main`,
  ` ${scope('quiet')}/lane:main `,
]
const ids = [
  'present-outside',
  'missing',
  'present-quiet',
  'present-quiet',
  'present-alternate',
  'present-recent',
]
async function seats(body: any) {
  const request = new Request('http://scratch.invalid/v1/presentation/seats/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    return { value: await (await handleReadPresentationSeats(db, request)).json() }
  } catch (error: any) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
}
try {
  if (mode === 'seed') {
    for (let i = 0; i < 270; i++) {
      const n = `bulk${i}`
      session(n, 1, since)
      if (i === 0) runtime(n, `present-${n}-1`)
    }
    const quiet = session('quiet')
    db.continuities.upsert({
      scopeRef: scope('quiet'),
      laneRef: 'main',
      activeHostSessionId: quiet,
      updatedAt: old,
    })
    runtime('quiet', quiet, 1, 'awaiting_input', {
      runtimeStateJson: {
        broker: hosting,
        contextReading: { malformedButStored: true, units: '\ud800' },
      },
      presentation: { mode: 'stored', extra: null },
      tmuxJson: { socketPath: '/override/socket', sessionName: 'override', windowName: 'view' },
    })
    runtime('quiet-second', quiet, 1, 'ready', {
      runtimeStateJson: { broker: { ...hosting, presentation: { kind: 'none' } } },
      presentation: null,
      tmuxJson: { socketPath: '/cannot/attach' },
    })
    db.sessionMetadata.write({
      scopeRef: scope('quiet'),
      laneRef: 'main',
      source: 'launch',
      set: { title: 'launch-title' },
      updatedBy: 'fixture',
      updatedAt: old,
    })
    db.sessionMetadata.write({
      scopeRef: scope('quiet'),
      laneRef: 'main',
      source: 'api',
      set: { title: 'api-title', 'appearance.color': '#abcdef' },
      updatedBy: 'fixture',
      updatedAt: old,
    })
    for (const [surfaceKind, surfaceId, clientTty] of [
      ['ghostty', 'z', '/dev/tty1'],
      ['ghostty', 'a', ''],
      ['other', 'ignored', '/dev/tty2'],
      ['ghostty', 'missing', undefined],
    ]) {
      db.surfaceBindings.bind({
        surfaceKind,
        surfaceId,
        clientTty,
        hostSessionId: quiet,
        runtimeId: 'present-quiet',
        generation: 1,
        boundAt: old,
      })
    }
    session('recent', 1, since)
    const newer = session('recent', 2, old)
    runtime('recent', newer, 2, 'dead')
    session('boundary', 1, since)
    session('outside', 1, '2026-10-21T23:59:59.999Z')
    runtime('outside', 'present-outside-1', 1, 'dead')
    session('fallback', 1, since)
    const fallback = session('fallback', 2, old)
    session('fallback', 3, old)
    runtime('fallback', fallback, 2)
    runtime('fallback-second', 'present-fallback-1', 1)
    const active = session('active')
    runtime('active', active, 1, 'dead', { activeRunId: 'opaque-active' })
    const alt = session('alternate', 1, since, 'alt')
    runtime('alternate', alt, 1, 'ready', {
      laneRef: 'lane:alt',
      runtimeStateJson: {
        broker: {
          endpoint: { kind: 'stdio-jsonrpc-ndjson' },
          brokerWindow: { ...window, socketPath: '/flat/socket', sessionName: 'flat' },
          observerWindow: window,
        },
      },
      presentation: { kind: 'none' },
    })
    for (const [host, g] of [
      [quiet, 1],
      [quiet, 2],
      ['present-recent-1', 1],
      ['present-recent-1', 1],
      ['present-fallback-2', 2],
    ])
      db.hrcEvents.append({
        ts: old,
        hostSessionId: host,
        scopeRef: scope(host.split('-')[1]),
        laneRef: 'main',
        generation: g,
        category: 'turn',
        eventKind: 'turn.message',
        payload: { host, g },
      })
    await emit({ seeded: true, refs, ids, since, now })
  } else if (mode === 'observe') {
    db.sqlite.exec('PRAGMA query_only=ON')
    Date.now = () => Date.parse(now)
    const outcomes: any = {
      full: await seats({ sessionRefs: refs, runtimeIds: ids }),
      empty: await seats({ sessionRefs: [], runtimeIds: [] }),
      runtimeOnly: await seats({ sessionRefs: [], runtimeIds: ids }),
      alias: await seats({
        sessionRefs: [`${scope('alternate')}/lane:alt`, `${scope('alternate')}/lane:lane:alt`],
        runtimeIds: [],
      }),
      missing: await seats({
        sessionRefs: [`${scope('absent')}/lane:main`],
        runtimeIds: ['missing'],
      }),
    }
    const projected = db.runtimes
      .listAll()
      .filter((r: any) => r.runtimeId.startsWith('present-'))
      .map((r: any) => projectPresentationRuntime(db, r))
    outcomes.projected = projected
    outcomes.invalid = []
    for (const body of [
      {},
      { sessionRefs: [''], runtimeIds: [] },
      { sessionRefs: [17], runtimeIds: [] },
      { sessionRefs: ['no-lane'], runtimeIds: [] },
      { sessionRefs: [' /lane: '], runtimeIds: [] },
      { sessionRefs: [], runtimeIds: [''] },
    ])
      outcomes.invalid.push(await seats(body))
    await emit({ result: outcomes })
  } else if (mode === 'chunks') {
    db.sqlite.exec('PRAGMA query_only=ON')
    Date.now = () => Date.parse(now)
    const inputs: any[] = []
    const merged: any = { sessions: new Map(), runtimes: new Map(), events: new Map() }
    const requests: any[] = []
    for (let i = 0; i < refs.length; i += 128)
      requests.push({ sessionRefs: refs.slice(i, i + 128), runtimeIds: [] })
    requests.push({ sessionRefs: [], runtimeIds: ids })
    for (const body of requests) {
      inputs.push({ ...body, since })
      const response: any = await seats(body)
      if (response.error) throw Error(JSON.stringify(response.error))
      for (const kind of ['sessions', 'runtimes', 'events'])
        for (const row of response.value[kind])
          merged[kind].set(kind === 'runtimes' ? row.runtimeId : row.hostSessionId, row)
    }
    await emit({
      result: {
        inputs,
        value: Object.fromEntries(
          Object.entries(merged).map(([k, v]: any) => [k, [...v.values()]])
        ),
      },
    })
  } else if (mode === 'mutate') {
    db.runtimes.updateActivity('present-quiet', now, now)
    await emit({ runtime: db.runtimes.getByRuntimeId('present-quiet') })
  } else throw Error('unknown scenario')
} finally {
  db.close()
}
