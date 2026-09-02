/**
 * T-07907: prove reply-is-ack attribution against one warm, installed tmux seat.
 *
 * Usage:
 *   bun scripts/smoke-envelope-attribution.ts \
 *     clod@hrc-runtime:T-07907 \
 *     /Users/lherron/praesidium/var/wrkq-artifacts/T-07907 \
 *     [--start-at=A1|A2|B1|B2|C1]
 *
 * The script intentionally talks only through installed `hrc`/`wrkc` binaries
 * and grades from wrkq envelope rows plus HRC's persisted broker ledger. It
 * terminates the runtime it births on every handled exit path.
 */

import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const DEFAULT_TARGET = 'clod@hrc-runtime:T-07907'
const DEFAULT_ARTIFACT_DIR = '/Users/lherron/praesidium/var/wrkq-artifacts/T-07907'
const DB_PATH = '/Users/lherron/praesidium/var/state/hrc/state.sqlite'
const SERVER_LOG = '/Users/lherron/praesidium/var/logs/hrc-server.log'
const ROOM = 'T-07907'
const SAY_TIMEOUT = '8m'
const POLL_MS = 500

type RuntimeRow = {
  runtime_id: string
  active_invocation_id: string | null
  status: string
  controller_kind: string | null
  harness: string
  transport: string
}

type BrokerRow = {
  seq: number
  time: string
  type: string
  run_id: string | null
  invocation_id: string
  broker_event_json: string
}

type Party = { principalRef: string; scopeRef?: string }
type Presentation = {
  runtimeId?: string
  runId?: string
  inputId?: string
  driveAttemptId?: string
}
type Envelope = {
  id: string
  from: Party
  to?: Party
  body: string
  state: string
  reason?: string
  meta: Record<string, unknown>
  presentedTo: Presentation[]
}
type RoomLog = Envelope[] | { items: Envelope[] }

type ProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type PendingSay = {
  label: string
  principal: string
  token: string
  body: string
  sourceId?: string
  result: Promise<ProcessResult>
}

type EnvelopeGrade = {
  label: string
  principal: string
  token: string
  envelopeId: string
  turnId: string
  runId: string
  replyId: string
  replyKind: 'auto' | 'manual' | ''
  addressee: string
  dischargeEnvelopeIds: string[]
  waitExitCode: number
  clauses: Record<'1' | '2' | '3' | '4' | '5', boolean | null>
  failures: string[]
}

type VariantSummary = {
  variant: string
  runtimeId: string
  invocationIds: string[]
  batching: string
  grades: EnvelopeGrade[]
  warningCount: number
  passed: boolean
}

const target = process.argv[2] ?? DEFAULT_TARGET
const artifactRoot = resolve(process.argv[3] ?? DEFAULT_ARTIFACT_DIR)
const startAt =
  process.argv.find((argument) => argument.startsWith('--start-at='))?.split('=')[1] ?? 'A1'
const targetScope = scopeRefForHandle(target)
const db = new Database(DB_PATH, { readonly: true, strict: true })
const childProcesses = new Set<ReturnType<typeof Bun.spawn>>()
let runtimeId: string | undefined
let cleanupStarted = false

function scopeRefForHandle(handle: string): string {
  const match = /^([^@]+)@([^:]+):(.+)$/.exec(handle)
  if (match === null) throw new Error(`target must be agent@project:scope, got ${handle}`)
  const [, agent, project, scope] = match
  if (agent === undefined || project === undefined || scope === undefined) {
    throw new Error(`could not parse target ${handle}`)
  }
  return scope === 'primary'
    ? `agent:${agent}:project:${project}`
    : `agent:${agent}:project:${project}:task:${scope}`
}

function probeEnvironment(): Record<string, string> {
  const { HRC_SESSION_REF: _ignored, ...environment } = process.env
  return environment as Record<string, string>
}

function spawnCommand(
  command: string[],
  options: { stdin?: string; probeIdentity?: boolean } = {}
): Promise<ProcessResult> {
  const child = Bun.spawn(command, {
    cwd: resolve(import.meta.dir, '..'),
    env: options.probeIdentity === true ? probeEnvironment() : process.env,
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  childProcesses.add(child)
  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin)
    child.stdin.end()
  }
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => {
    childProcesses.delete(child)
    return { exitCode, stdout, stderr }
  })
}

async function commandJson<T>(command: string[], probeIdentity = false): Promise<T> {
  const result = await spawnCommand(command, { probeIdentity })
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(' ')} exited ${result.exitCode}: ${result.stderr || result.stdout}`
    )
  }
  return JSON.parse(result.stdout) as T
}

function currentRuntime(): RuntimeRow | undefined {
  return (
    db
      .query<RuntimeRow, [string]>(
        `SELECT runtime_id, active_invocation_id, status, controller_kind, harness, transport
       FROM runtimes
       WHERE scope_ref = ? AND status NOT IN ('terminated', 'failed')
       ORDER BY created_at DESC
       LIMIT 1`
      )
      .get(targetScope) ?? undefined
  )
}

function brokerRows(sinceSeq = 0): BrokerRow[] {
  if (runtimeId === undefined) throw new Error('runtime not established')
  return db
    .query<BrokerRow, [string, number]>(
      `SELECT seq, time, type, run_id, invocation_id, broker_event_json
       FROM broker_invocation_events
       WHERE runtime_id = ? AND seq > ?
       ORDER BY invocation_id, seq`
    )
    .all(runtimeId, sinceSeq) as BrokerRow[]
}

function payload(row: BrokerRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.broker_event_json) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function maxSeq(): number {
  if (runtimeId === undefined) return 0
  const row = db
    .query<{ seq: number }, [string]>(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM broker_invocation_events WHERE runtime_id = ?'
    )
    .get(runtimeId)
  return row?.seq ?? 0
}

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(POLL_MS)
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function waitForSeat(status: 'busy' | 'ready', timeoutMs = 180_000): Promise<void> {
  await waitUntil(
    `seat ${status}`,
    () => {
      const row = currentRuntime()
      return row?.runtime_id === runtimeId && row.status === status
    },
    timeoutMs
  )
}

async function establishReadySeat(row: RuntimeRow, description: string): Promise<void> {
  runtimeId = row.runtime_id
  if (
    row.controller_kind !== 'harness-broker' ||
    row.harness !== 'claude-code' ||
    row.transport !== 'tmux'
  ) {
    throw new Error(`unexpected ${description}: ${JSON.stringify(row)}`)
  }
  if (row.status !== 'ready') await waitForSeat('ready')
}

async function waitForUserToken(token: string, sinceSeq: number, timeoutMs = 180_000) {
  let match: BrokerRow | undefined
  await waitUntil(
    `user.message containing ${token}`,
    () => {
      match = brokerRows(sinceSeq).find(
        (row) => row.type === 'user.message' && String(payload(row).content ?? '').includes(token)
      )
      return match !== undefined
    },
    timeoutMs
  )
  return match as BrokerRow
}

async function roomLog(principal = 'agent:probe-a'): Promise<RoomLog> {
  return await commandJson<RoomLog>(['wrkc', 'log', ROOM, '--as', principal, '--json'], true)
}

async function showEnvelope(id: string, principal: string): Promise<Envelope> {
  return await commandJson<Envelope>(['wrkc', 'show', id, '--as', principal, '--json'], true)
}

function roomItems(log: RoomLog): Envelope[] {
  return Array.isArray(log) ? log : log.items
}

async function waitForSourceId(say: PendingSay): Promise<string> {
  let id: string | undefined
  await waitUntil(
    `source envelope for ${say.token}`,
    async () => {
      id = roomItems(await roomLog(say.principal)).find(
        (item) => item.from.principalRef === say.principal && item.body === say.body
      )?.id
      return id !== undefined
    },
    30_000
  )
  say.sourceId = id
  return id as string
}

function startSay(label: string, principal: string, token: string): PendingSay {
  const body = `Run \`sleep 45\` with Bash, then end your turn with exactly this line and nothing else: ${token}`
  const result = spawnCommand(
    [
      'wrkc',
      'say',
      ROOM,
      '--to',
      target,
      '--as',
      principal,
      '--wait',
      '--timeout',
      SAY_TIMEOUT,
      '--json',
      '-',
    ],
    { stdin: `${body}\n`, probeIdentity: true }
  )
  return { label, principal, token, body, result }
}

async function startHolder(label: string, seconds: number, sinceSeq: number) {
  const token = `HOLDER-${label}-${randomUUID().slice(0, 8)}`
  const prompt = `Run \`sleep ${seconds}\` with Bash, then end your turn with exactly this line and nothing else: ${token}`
  const result = spawnCommand(['hrc', 'turn', target, '--wait', 'final', '--timeout', '5m', prompt])
  await waitForUserToken(token, sinceSeq)
  await waitForSeat('busy')
  return { token, result }
}

function tokenFor(variant: string, label: string): string {
  return `ACK-PROBE-${label}-${variant}-${randomUUID().slice(0, 8)}`
}

async function runVariantA(name: string): Promise<VariantSummary> {
  const startSeq = maxSeq()
  const logOffset = (await stat(SERVER_LOG)).size
  console.log(`${name}: starting 90-second holder`)
  const holder = await startHolder(name, 90, startSeq)
  const says = ['A', 'B', 'C'].map((label) =>
    startSay(label, `agent:probe-${label.toLowerCase()}`, tokenFor(name, label))
  )
  await Promise.all(says.map(waitForSourceId))
  console.log(`${name}: three distinct-principal envelopes queued; waiting for replies`)
  const holderResult = await holder.result
  if (holderResult.exitCode !== 0) {
    throw new Error(`${name} holder failed: ${holderResult.stderr || holderResult.stdout}`)
  }
  const waitResults = await Promise.all(says.map((say) => say.result))
  return await collectVariant(name, startSeq, logOffset, says, waitResults)
}

async function runVariantB(name: string): Promise<VariantSummary> {
  const startSeq = maxSeq()
  const logOffset = (await stat(SERVER_LOG)).size
  console.log(`${name}: starting boundary holder`)
  const holder = await startHolder(name, 20, startSeq)
  const says: PendingSay[] = []

  const first = startSay('A', 'agent:probe-a', tokenFor(name, 'A'))
  says.push(first)
  await waitForSourceId(first)
  await holder.result
  await waitForUserToken(first.token, startSeq)
  console.log(`${name}: A turn active; queueing B`)

  const second = startSay('B', 'agent:probe-b', tokenFor(name, 'B'))
  says.push(second)
  await waitForSourceId(second)
  await waitForUserToken(second.token, startSeq, 240_000)
  console.log(`${name}: B turn active; queueing C`)

  const third = startSay('C', 'agent:probe-c', tokenFor(name, 'C'))
  says.push(third)
  await waitForSourceId(third)
  const waitResults = await Promise.all(says.map((say) => say.result))
  return await collectVariant(name, startSeq, logOffset, says, waitResults)
}

async function runVariantC(name: string): Promise<VariantSummary> {
  const startSeq = maxSeq()
  const logOffset = (await stat(SERVER_LOG)).size
  console.log(`${name}: starting fan-out control holder`)
  const holder = await startHolder(name, 45, startSeq)
  const principal = 'agent:probe-fanout'
  const says = ['A', 'B', 'C'].map((label) => startSay(label, principal, tokenFor(name, label)))
  await Promise.all(says.map(waitForSourceId))
  await holder.result
  const waitResults = await Promise.all(says.map((say) => say.result))
  return await collectVariant(name, startSeq, logOffset, says, waitResults)
}

function turnForEnvelope(rows: BrokerRow[], envelope: Envelope) {
  const presentedRuns = new Set(envelope.presentedTo.map((presentation) => presentation.runId))
  const bodyUser = rows.find(
    (row) =>
      row.type === 'user.message' &&
      row.run_id !== null &&
      presentedRuns.has(row.run_id) &&
      String(payload(row).content ?? '').includes(envelope.body)
  )
  if (bodyUser !== undefined) {
    const turnId = payload(bodyUser).turnId
    return {
      submissionId: '',
      turnId: typeof turnId === 'string' ? turnId : '',
      runId: bodyUser.run_id ?? '',
      userContent: String(payload(bodyUser).content ?? ''),
    }
  }
  const admission = rows.find(
    (row) =>
      row.type === 'admission.requested' &&
      (payload(row).origin as Record<string, unknown> | undefined)?.envelopeId === envelope.id
  )
  const submissionId = admission === undefined ? undefined : payload(admission).submissionId
  const disposition = rows.find(
    (row) =>
      (row.type === 'submission.executed' || row.type === 'submission.absorbed') &&
      payload(row).submissionId === submissionId
  )
  const turnId = disposition === undefined ? undefined : payload(disposition).turnId
  const user = rows.find((row) => row.type === 'user.message' && payload(row).turnId === turnId)
  return {
    submissionId: typeof submissionId === 'string' ? submissionId : '',
    turnId: typeof turnId === 'string' ? turnId : '',
    runId: user?.run_id ?? disposition?.run_id ?? '',
    userContent: user === undefined ? '' : String(payload(user).content ?? ''),
  }
}

function replyFromWait(result: ProcessResult): Envelope | undefined {
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    if (!Array.isArray(parsed)) return undefined
    return parsed.find(
      (item): item is Envelope =>
        item !== null && typeof item === 'object' && typeof (item as Envelope).id === 'string'
    )
  } catch {
    return undefined
  }
}

function dischargeIds(envelope: Envelope): string[] {
  const ids = envelope.meta.dischargeEnvelopeIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

async function collectVariant(
  name: string,
  startSeq: number,
  logOffset: number,
  says: PendingSay[],
  waitResults: ProcessResult[]
): Promise<VariantSummary> {
  await Bun.sleep(1_000)
  const rows = brokerRows(startSeq)
  const sourceById = new Map<string, Envelope>()
  for (const say of says) {
    if (say.sourceId === undefined) throw new Error(`${name}/${say.label}: missing source id`)
    const source = await showEnvelope(say.sourceId, say.principal)
    sourceById.set(source.id, source)
  }
  const replyBySource = new Map<string, Envelope>()
  for (const [index, say] of says.entries()) {
    const reply = replyFromWait(waitResults[index] as ProcessResult)
    if (say.sourceId !== undefined && reply !== undefined) {
      replyBySource.set(say.sourceId, await showEnvelope(reply.id, say.principal))
    }
  }
  const grades: EnvelopeGrade[] = []

  for (const [index, say] of says.entries()) {
    const sourceId = say.sourceId as string
    const source = sourceById.get(sourceId) as Envelope
    const reply = replyBySource.get(sourceId)
    const turn = turnForEnvelope(rows, source)
    const failures: string[] = []
    const ids = reply === undefined ? [] : dischargeIds(reply)
    const isAuto = reply?.meta.auto === 'turn_final'
    const turnSources = says.filter((candidate) => turn.userContent.includes(candidate.body))
    const clause1 =
      reply !== undefined &&
      (isAuto
        ? ids.length > 0 &&
          ids.every((id) => {
            const discharged = sourceById.get(id)
            return discharged !== undefined && turn.userContent.includes(discharged.body)
          })
        : turn.userContent.includes(source.body))
    const clause2 =
      reply !== undefined &&
      (isAuto
        ? turnSources.every(
            (candidate) => candidate.sourceId !== undefined && ids.includes(candidate.sourceId)
          )
        : turnSources.every(
            (candidate) => candidate.sourceId !== undefined && replyBySource.has(candidate.sourceId)
          ))
    const clause3 = isAuto ? reply.to?.principalRef === source.from.principalRef : null
    const clause4 =
      turn.runId !== '' &&
      source.presentedTo.some((presentation) => presentation.runId === turn.runId)
    const wait = waitResults[index] as ProcessResult
    const otherTokens = says
      .filter((candidate) => candidate !== say)
      .map((candidate) => candidate.token)
    const clause5 =
      wait.exitCode === 0 &&
      wait.stdout.includes(say.token) &&
      otherTokens.every((token) => !wait.stdout.includes(token))
    const clauses = {
      '1': clause1,
      '2': clause2,
      '3': clause3,
      '4': clause4,
      '5': clause5,
    }
    for (const [clause, passed] of Object.entries(clauses)) {
      if (passed === false) failures.push(`invariant ${clause} failed`)
    }
    grades.push({
      label: say.label,
      principal: say.principal,
      token: say.token,
      envelopeId: sourceId,
      turnId: turn.turnId,
      runId: turn.runId,
      replyId: reply?.id ?? '',
      replyKind: reply === undefined ? '' : isAuto ? 'auto' : 'manual',
      addressee: reply?.to?.principalRef ?? '',
      dischargeEnvelopeIds: ids,
      waitExitCode: wait.exitCode,
      clauses,
      failures,
    })
  }

  const warnings = rows.filter(
    (row) => row.type === 'capture.warning' && payload(row).family === 'submission-disposition'
  )
  const turnIds = new Set(grades.map((grade) => grade.turnId).filter(Boolean))
  const batching =
    turnIds.size === 1
      ? `coalesced (${says.length} envelopes in one turn)`
      : `per-turn (${turnIds.size} turns for ${says.length} envelopes)`
  const invocationIds = [...new Set(rows.map((row) => row.invocation_id))]
  const shownEnvelopes = new Map<string, Envelope>()
  for (const envelope of [...sourceById.values(), ...replyBySource.values()]) {
    shownEnvelopes.set(envelope.id, envelope)
  }
  const summary: VariantSummary = {
    variant: name,
    runtimeId: runtimeId as string,
    invocationIds,
    batching,
    grades,
    warningCount: warnings.length,
    passed: warnings.length === 0 && grades.every((grade) => grade.failures.length === 0),
  }
  const artifactDir = join(artifactRoot, name.toLowerCase())
  await mkdir(artifactDir, { recursive: true })
  const rawLog = await readFile(SERVER_LOG)
  const relevantServerLog = rawLog
    .subarray(logOffset)
    .toString('utf8')
    .split('\n')
    .filter(
      (line) =>
        line.includes(target) &&
        (line.includes('wrkq.kicker.') || line.includes('wrkq.auto_reply.'))
    )
    .join('\n')
  await Promise.all([
    writeFile(
      join(artifactDir, 'ledger.ndjson'),
      `${rows.map((row) => JSON.stringify({ ...row, event: payload(row) })).join('\n')}\n`
    ),
    writeFile(
      join(artifactDir, 'envelopes.json'),
      `${JSON.stringify([...shownEnvelopes.values()], null, 2)}\n`
    ),
    writeFile(
      join(artifactDir, 'wrkc-show.json'),
      `${JSON.stringify([...shownEnvelopes.values()], null, 2)}\n`
    ),
    writeFile(join(artifactDir, 'server.log'), `${relevantServerLog}\n`),
    writeFile(join(artifactDir, 'wait-results.json'), `${JSON.stringify(waitResults, null, 2)}\n`),
    writeFile(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`),
  ])
  printSummary(summary)
  if (!summary.passed) {
    throw new Error(`${name}: attribution invariant failed; see ${artifactDir}`)
  }
  return summary
}

function printSummary(summary: VariantSummary): void {
  console.log(`\n${summary.variant}: ${summary.batching}`)
  console.log('envelope\tturn/run\treply\taddressee\ttoken\tI1-I5')
  for (const grade of summary.grades) {
    const verdicts = Object.values(grade.clauses)
      .map((pass) => (pass === null ? 'N' : pass ? 'P' : 'F'))
      .join('')
    console.log(
      [
        grade.envelopeId,
        `${grade.turnId}/${grade.runId}`,
        `${grade.replyId}${grade.replyKind === '' ? '' : ` (${grade.replyKind})`}`,
        grade.addressee,
        grade.token,
        verdicts,
      ].join('\t')
    )
  }
}

async function writeEnvironmentEvidence(): Promise<void> {
  const serverStatus = await commandJson<Record<string, unknown>>([
    'hrc',
    'server',
    'status',
    '--json',
  ])
  await mkdir(artifactRoot, { recursive: true })
  await writeFile(
    join(artifactRoot, 'installed-server-status.json'),
    `${JSON.stringify(serverStatus, null, 2)}\n`
  )
}

async function terminateProbe(): Promise<void> {
  if (cleanupStarted) return
  cleanupStarted = true
  const children = [...childProcesses]
  for (const child of children) child.kill()
  await Promise.allSettled(children.map(async (child) => await child.exited))
  const terminated = new Set<string>()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ids = [runtimeId, currentRuntime()?.runtime_id].filter(
      (id): id is string => id !== undefined && !terminated.has(id)
    )
    if (ids.length === 0) break
    for (const id of ids) {
      const result = await spawnCommand([
        'hrc',
        'runtime',
        'terminate',
        id,
        '--drop-continuation',
        '--reason',
        'T-07907 attribution smoke cleanup',
        '--source',
        basename(import.meta.path),
      ])
      terminated.add(id)
      if (result.exitCode !== 0) {
        console.error(`cleanup failed for ${id}: ${result.stderr || result.stdout}`)
      }
    }
    await Bun.sleep(1_000)
  }
}

async function main(): Promise<void> {
  await writeEnvironmentEvidence()
  const existing = currentRuntime()
  if (existing !== undefined) {
    await establishReadySeat(existing, 'existing seat')
    console.log(`using prewarmed ready seat: ${runtimeId}`)
  } else {
    console.log(`warming ${target} with no envelope in flight`)
    const warmToken = `WARM-SEAT-${randomUUID().slice(0, 8)}`
    const warm = await spawnCommand([
      'hrc',
      'turn',
      target,
      '--wait',
      'final',
      '--timeout',
      '5m',
      `End your turn with exactly this line and nothing else: ${warmToken}`,
    ])
    if (warm.exitCode !== 0) {
      throw new Error(`warm turn failed: ${warm.stderr || warm.stdout}`)
    }
    const row = currentRuntime()
    if (row === undefined) throw new Error('warm turn completed without a live runtime')
    await establishReadySeat(row, 'warm seat')
    console.log(`warm seat ready: ${runtimeId}`)
  }

  const variants = [
    ['A1', runVariantA],
    ['A2', runVariantA],
    ['B1', runVariantB],
    ['B2', runVariantB],
    ['C1', runVariantC],
  ] as const
  const startIndex = variants.findIndex(([name]) => name === startAt)
  if (startIndex === -1) throw new Error(`unknown --start-at value: ${startAt}`)
  const summaries: VariantSummary[] = []
  for (const [name, run] of variants.slice(startIndex)) summaries.push(await run(name))
  await writeFile(
    join(artifactRoot, 'summary.json'),
    `${JSON.stringify({ target, targetScope, runtimeId, summaries }, null, 2)}\n`
  )
  console.log(`\nPASS: all variants; evidence at ${artifactRoot}`)
}

let exitCode = 0
try {
  await main()
} catch (error) {
  exitCode = 1
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await terminateProbe()
  db.close()
}
process.exit(exitCode)
