import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
  type HrcActuatorSplitAuthorityView,
  type HrcActuatorSplitPolicy,
  type HrcApprovedMutationRef,
  type HrcRuntimeIntent,
  type HrcRuntimeSnapshot,
  HrcRuntimeUnavailableError,
} from 'hrc-core'
import { type InvocationStartRequest, isCredentialEnvKey } from 'spaces-harness-broker-protocol'

export type ActuatorSplitRoute =
  | 'broker'
  | 'sdk'
  | 'legacy-exec'
  | 'interactive-broker'
  | 'legacy-tmux'

export type ResolvedApprovedMutation = {
  approvalRecordHash: string
  artifactContentHash: string
  artifactPath: string
  workspaceRoot: string
  targetPaths: string[]
  expectedBaseRevision?: string | undefined
  expectedBaseTreeHash?: string | undefined
  approvedBy: string
  approvedAt: string
}

export type ActuatorSplitAuthority = {
  actuatorSplit: HrcActuatorSplitPolicy
  approvedMutation?: ResolvedApprovedMutation | undefined
}

export type PreparedActuatorSplitIntent = {
  intent: HrcRuntimeIntent
  authority?: ActuatorSplitAuthority | undefined
}

type ApprovalEvidenceRecord = {
  schemaVersion: 'hrc.approved-mutation-approval/v1'
  source: HrcApprovedMutationRef['source']
  artifactRef: string
  artifactKind: HrcApprovedMutationRef['artifactKind']
  artifactContentHash: string
  targetPaths: string[]
  expectedBaseRevision?: string | undefined
  expectedBaseTreeHash?: string | undefined
  taskRef?: string | undefined
  taskSpecHash?: string | undefined
  taskEtag?: string | undefined
  workflowRunId?: string | undefined
  actionRunId?: string | undefined
  approvedBy: string
  approvedAt: string
}

const ACTUATOR_SPLIT_SCHEMA = 'hrc.actuator-split-policy/v1'
const APPROVED_MUTATION_SCHEMA = 'hrc.approved-mutation-ref/v1'
const APPROVAL_EVIDENCE_SCHEMA = 'hrc.approved-mutation-approval/v1'
const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/i
const APPROVAL_REF_FRAGMENT_PATTERN = /^sha256(?::|=)([a-f0-9]{64})$/i
const WRITE_LANES = new Set<HrcActuatorSplitPolicy['laneClass']>(['actuator'])

function reject(reason: string, detail: Record<string, unknown> = {}): never {
  throw new HrcRuntimeUnavailableError(`actuator-split admission rejected: ${reason}`, {
    reason,
    ...detail,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, field: string, reason: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    reject(reason, { field })
  }
  return value.trim()
}

function requireStringArray(
  record: Record<string, unknown>,
  field: string,
  reason: string
): string[] {
  const value = record[field]
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    reject(reason, { field })
  }
  return value.map((entry) => String(entry).trim())
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    reject('malformed-approved-mutation-ref', { field })
  }
  return value.trim()
}

function normalizeHash(value: string, reason: string): string {
  const matched = SHA256_PATTERN.exec(value.trim())
  if (!matched?.[1]) reject(reason)
  return matched[1].toLowerCase()
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function normalizeRelativePath(value: string, reason: string, allowRoot = false): string {
  const candidate = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
  if (
    candidate.length === 0 ||
    candidate.includes('\0') ||
    isAbsolute(candidate) ||
    candidate.split('/').some((segment) => segment === '..')
  ) {
    reject(reason, { path: value })
  }
  const normalized = candidate.replaceAll(/\/+/g, '/').replace(/\/$/, '')
  if (normalized === '.' && allowRoot) return '.'
  if (normalized === '.' || normalized.length === 0) reject(reason, { path: value })
  return normalized
}

function normalizePathSet(values: string[], reason: string, allowRoot = false): string[] {
  const normalized = values.map((value) => normalizeRelativePath(value, reason, allowRoot))
  if (new Set(normalized).size !== normalized.length) reject(reason, { duplicate: true })
  return normalized
}

function parseApprovedMutationRef(input: unknown): HrcApprovedMutationRef {
  if (!isRecord(input)) reject('missing-approved-mutation-ref')
  if (input['schemaVersion'] !== APPROVED_MUTATION_SCHEMA) {
    reject('invalid-approved-mutation-schema')
  }
  const source = requireString(input, 'source', 'malformed-approved-mutation-ref')
  if (source !== 'wrkf-action' && source !== 'manual-operator') {
    reject('malformed-approved-mutation-ref', { field: 'source' })
  }
  const artifactKind = requireString(input, 'artifactKind', 'malformed-approved-mutation-ref')
  if (
    artifactKind !== 'unified-diff' &&
    artifactKind !== 'git-apply-patch' &&
    artifactKind !== 'file-set'
  ) {
    reject('malformed-approved-mutation-ref', { field: 'artifactKind' })
  }
  const targetPaths = normalizePathSet(
    requireStringArray(input, 'targetPaths', 'malformed-approved-mutation-ref'),
    'invalid-approved-target-path'
  )
  const artifactContentHash = optionalString(input, 'artifactContentHash')
  if (artifactContentHash === undefined) reject('artifact-content-hash-required')

  return {
    schemaVersion: APPROVED_MUTATION_SCHEMA,
    source,
    approvalRef: requireString(input, 'approvalRef', 'malformed-approved-mutation-ref'),
    artifactRef: requireString(input, 'artifactRef', 'malformed-approved-mutation-ref'),
    artifactKind,
    targetPaths,
    artifactContentHash: `sha256:${normalizeHash(
      artifactContentHash,
      'invalid-artifact-content-hash'
    )}`,
    ...(optionalString(input, 'expectedBaseRevision') !== undefined
      ? { expectedBaseRevision: optionalString(input, 'expectedBaseRevision') }
      : {}),
    ...(optionalString(input, 'expectedBaseTreeHash') !== undefined
      ? { expectedBaseTreeHash: optionalString(input, 'expectedBaseTreeHash') }
      : {}),
    ...(optionalString(input, 'taskRef') !== undefined
      ? { taskRef: optionalString(input, 'taskRef') }
      : {}),
    ...(optionalString(input, 'taskSpecHash') !== undefined
      ? { taskSpecHash: optionalString(input, 'taskSpecHash') }
      : {}),
    ...(optionalString(input, 'taskEtag') !== undefined
      ? { taskEtag: optionalString(input, 'taskEtag') }
      : {}),
    ...(optionalString(input, 'workflowRunId') !== undefined
      ? { workflowRunId: optionalString(input, 'workflowRunId') }
      : {}),
    ...(optionalString(input, 'actionRunId') !== undefined
      ? { actionRunId: optionalString(input, 'actionRunId') }
      : {}),
    ...(optionalString(input, 'approvedBy') !== undefined
      ? { approvedBy: optionalString(input, 'approvedBy') }
      : {}),
    ...(optionalString(input, 'approvedAt') !== undefined
      ? { approvedAt: optionalString(input, 'approvedAt') }
      : {}),
  }
}

export function normalizeActuatorSplitPolicy(input: unknown): HrcActuatorSplitPolicy | undefined {
  if (input === undefined) return undefined
  if (!isRecord(input)) reject('malformed-actuator-split-policy')
  if (input['schemaVersion'] !== ACTUATOR_SPLIT_SCHEMA) {
    reject('invalid-actuator-split-schema')
  }
  const mode = requireString(input, 'mode', 'malformed-actuator-split-policy')
  if (mode !== 'off' && mode !== 'high-risk') {
    reject('malformed-actuator-split-policy', { field: 'mode' })
  }
  const laneClass = requireString(input, 'laneClass', 'malformed-actuator-split-policy')
  if (!['worker', 'verifier', 'reviewer', 'approver', 'actuator'].includes(laneClass)) {
    reject('malformed-actuator-split-policy', { field: 'laneClass' })
  }
  const codeMutation = requireString(input, 'codeMutation', 'malformed-actuator-split-policy')
  if (!['forbidden', 'staged-output-only', 'apply-approved-artifact'].includes(codeMutation)) {
    reject('malformed-actuator-split-policy', { field: 'codeMutation' })
  }
  const productionCodePaths =
    input['productionCodePaths'] === undefined
      ? undefined
      : normalizePathSet(
          requireStringArray(input, 'productionCodePaths', 'malformed-actuator-split-policy'),
          'invalid-production-code-path',
          true
        )

  const normalized: HrcActuatorSplitPolicy = {
    schemaVersion: ACTUATOR_SPLIT_SCHEMA,
    mode,
    laneClass: laneClass as HrcActuatorSplitPolicy['laneClass'],
    codeMutation: codeMutation as HrcActuatorSplitPolicy['codeMutation'],
    ...(optionalString(input, 'workflowRef') !== undefined
      ? { workflowRef: optionalString(input, 'workflowRef') }
      : {}),
    ...(productionCodePaths !== undefined ? { productionCodePaths } : {}),
    ...(input['approval'] !== undefined
      ? { approval: parseApprovedMutationRef(input['approval']) }
      : {}),
  }

  if (mode === 'off') return normalized
  if (!productionCodePaths || productionCodePaths.length === 0) {
    reject('high-risk-production-code-paths-required')
  }
  if (WRITE_LANES.has(normalized.laneClass)) {
    if (
      normalized.codeMutation !== 'apply-approved-artifact' ||
      normalized.approval === undefined
    ) {
      reject('high-risk-actuator-requires-approved-artifact')
    }
  } else if (normalized.codeMutation === 'apply-approved-artifact') {
    reject('high-risk-non-actuator-cannot-apply-artifact')
  }
  return normalized
}

function effectivePolicy(intent: HrcRuntimeIntent): HrcActuatorSplitPolicy | undefined {
  return normalizeActuatorSplitPolicy(intent.execution?.actuatorSplit)
}

function workspaceRootFromIntent(intent: HrcRuntimeIntent): string {
  const placement = intent.placement as unknown
  if (!isRecord(placement)) reject('workspace-root-unresolvable')
  const candidate =
    typeof placement['projectRoot'] === 'string'
      ? placement['projectRoot']
      : typeof placement['cwd'] === 'string'
        ? placement['cwd']
        : undefined
  if (!candidate || !isAbsolute(candidate)) reject('workspace-root-unresolvable')
  return candidate
}

async function canonicalFileRef(
  ref: string,
  options: { requireHashFragment: boolean }
): Promise<{ path: string; content: Uint8Array; pinnedHash?: string | undefined }> {
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    reject('unresolvable-local-file-ref', { refKind: 'invalid-uri' })
  }
  if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost')) {
    reject('unresolvable-local-file-ref', { refKind: url.protocol })
  }
  const fragment = url.hash.slice(1)
  const fragmentMatch = APPROVAL_REF_FRAGMENT_PATTERN.exec(fragment)
  if (options.requireHashFragment && !fragmentMatch?.[1]) {
    reject('approval-ref-must-be-content-addressed')
  }
  url.hash = ''
  const requestedPath = decodeURIComponent(url.pathname)
  let canonicalPath: string
  try {
    canonicalPath = await realpath(requestedPath)
    const fileStat = await stat(canonicalPath)
    if (!fileStat.isFile()) reject('resolved-ref-is-not-a-file')
  } catch (error) {
    reject('unresolvable-local-file-ref', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const content = await readFile(canonicalPath)
  const pinnedHash = fragmentMatch?.[1]?.toLowerCase()
  if (pinnedHash !== undefined && sha256(content) !== pinnedHash) {
    reject('approval-record-hash-mismatch')
  }
  return { path: canonicalPath, content, ...(pinnedHash ? { pinnedHash } : {}) }
}

function parseApprovalRecord(content: Uint8Array): ApprovalEvidenceRecord {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(content))
  } catch {
    reject('approval-record-invalid-json')
  }
  if (!isRecord(value) || value['schemaVersion'] !== APPROVAL_EVIDENCE_SCHEMA) {
    reject('approval-record-invalid-schema')
  }
  const source = requireString(value, 'source', 'approval-record-malformed')
  const artifactKind = requireString(value, 'artifactKind', 'approval-record-malformed')
  if (source !== 'wrkf-action' && source !== 'manual-operator') {
    reject('approval-record-malformed', { field: 'source' })
  }
  if (
    artifactKind !== 'unified-diff' &&
    artifactKind !== 'git-apply-patch' &&
    artifactKind !== 'file-set'
  ) {
    reject('approval-record-malformed', { field: 'artifactKind' })
  }
  return {
    schemaVersion: APPROVAL_EVIDENCE_SCHEMA,
    source,
    artifactRef: requireString(value, 'artifactRef', 'approval-record-malformed'),
    artifactKind,
    artifactContentHash: `sha256:${normalizeHash(
      requireString(value, 'artifactContentHash', 'approval-record-malformed'),
      'approval-record-artifact-hash-invalid'
    )}`,
    targetPaths: normalizePathSet(
      requireStringArray(value, 'targetPaths', 'approval-record-malformed'),
      'approval-record-target-path-invalid'
    ),
    approvedBy: requireString(value, 'approvedBy', 'approval-record-malformed'),
    approvedAt: requireString(value, 'approvedAt', 'approval-record-malformed'),
    ...(optionalString(value, 'expectedBaseRevision') !== undefined
      ? { expectedBaseRevision: optionalString(value, 'expectedBaseRevision') }
      : {}),
    ...(optionalString(value, 'expectedBaseTreeHash') !== undefined
      ? { expectedBaseTreeHash: optionalString(value, 'expectedBaseTreeHash') }
      : {}),
    ...(optionalString(value, 'taskRef') !== undefined
      ? { taskRef: optionalString(value, 'taskRef') }
      : {}),
    ...(optionalString(value, 'taskSpecHash') !== undefined
      ? { taskSpecHash: optionalString(value, 'taskSpecHash') }
      : {}),
    ...(optionalString(value, 'taskEtag') !== undefined
      ? { taskEtag: optionalString(value, 'taskEtag') }
      : {}),
    ...(optionalString(value, 'workflowRunId') !== undefined
      ? { workflowRunId: optionalString(value, 'workflowRunId') }
      : {}),
    ...(optionalString(value, 'actionRunId') !== undefined
      ? { actionRunId: optionalString(value, 'actionRunId') }
      : {}),
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  )
}

function assertApprovalRecordMatches(
  approval: HrcApprovedMutationRef,
  evidence: ApprovalEvidenceRecord
): void {
  const exactFields = [
    'source',
    'artifactRef',
    'artifactKind',
    'artifactContentHash',
    'expectedBaseRevision',
    'expectedBaseTreeHash',
    'taskRef',
    'taskSpecHash',
    'taskEtag',
    'workflowRunId',
    'actionRunId',
  ] as const
  for (const field of exactFields) {
    if (approval[field] !== evidence[field]) {
      reject('approval-record-does-not-authorize-request', { field })
    }
  }
  if (!sameStringArray(approval.targetPaths, evidence.targetPaths)) {
    reject('approval-record-does-not-authorize-request', { field: 'targetPaths' })
  }
  if (approval.approvedBy !== undefined && approval.approvedBy !== evidence.approvedBy) {
    reject('approval-record-does-not-authorize-request', { field: 'approvedBy' })
  }
  if (approval.approvedAt !== undefined && approval.approvedAt !== evidence.approvedAt) {
    reject('approval-record-does-not-authorize-request', { field: 'approvedAt' })
  }
  if (approval.source === 'wrkf-action' && (!approval.workflowRunId || !approval.actionRunId)) {
    reject('wrkf-approval-correlation-required')
  }
}

function artifactTargetPaths(
  artifactKind: HrcApprovedMutationRef['artifactKind'],
  content: Uint8Array
): string[] {
  const text = new TextDecoder().decode(content)
  if (artifactKind === 'file-set') {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      reject('file-set-artifact-invalid-json')
    }
    if (!isRecord(value) || !Array.isArray(value['files']) || value['files'].length === 0) {
      reject('file-set-artifact-malformed')
    }
    return normalizePathSet(
      value['files'].map((entry) => {
        if (!isRecord(entry)) reject('file-set-artifact-malformed')
        return requireString(entry, 'path', 'file-set-artifact-malformed')
      }),
      'artifact-target-path-invalid'
    )
  }

  const paths = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue
    const token = line.slice(4).split('\t', 1)[0]?.trim()
    if (!token || token === '/dev/null') continue
    const candidate = token.startsWith('a/') || token.startsWith('b/') ? token.slice(2) : token
    paths.add(normalizeRelativePath(candidate, 'artifact-target-path-invalid'))
  }
  if (paths.size === 0) reject('patch-artifact-has-no-target-paths')
  return [...paths]
}

function assertTargetContainment(
  workspaceRoot: string,
  productionCodePaths: string[],
  targetPaths: string[]
): void {
  for (const targetPath of targetPaths) {
    const target = resolve(workspaceRoot, targetPath)
    const rel = relative(workspaceRoot, target)
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      reject('target-path-escapes-workspace', { targetPath })
    }
    const covered = productionCodePaths.some((productionPath) => {
      if (productionPath === '.') return true
      return targetPath === productionPath || targetPath.startsWith(`${productionPath}/`)
    })
    if (!covered) reject('target-path-outside-production-scope', { targetPath })
  }
}

async function gitValue(workspaceRoot: string, args: string[], reason: string): Promise<string> {
  const process = Bun.spawn(['git', '-C', workspaceRoot, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) reject(reason, { cause: stderr.trim() })
  return stdout.trim()
}

async function resolveApprovedMutation(
  intent: HrcRuntimeIntent,
  policy: HrcActuatorSplitPolicy
): Promise<ResolvedApprovedMutation> {
  const approval = policy.approval
  if (!approval) reject('missing-approved-mutation-ref')
  if (!approval.expectedBaseRevision && !approval.expectedBaseTreeHash) {
    reject('approved-mutation-base-fence-required')
  }
  const workspaceRoot = await realpath(workspaceRootFromIntent(intent)).catch((error: unknown) =>
    reject('workspace-root-unresolvable', {
      cause: error instanceof Error ? error.message : String(error),
    })
  )
  const approvalFile = await canonicalFileRef(approval.approvalRef, {
    requireHashFragment: true,
  })
  const evidence = parseApprovalRecord(approvalFile.content)
  assertApprovalRecordMatches(approval, evidence)

  const artifactFile = await canonicalFileRef(approval.artifactRef, {
    requireHashFragment: false,
  })
  const artifactHash = sha256(artifactFile.content)
  if (artifactHash !== normalizeHash(approval.artifactContentHash ?? '', 'invalid-artifact-hash')) {
    reject('artifact-content-hash-mismatch')
  }
  const actualTargets = artifactTargetPaths(approval.artifactKind, artifactFile.content)
  if (!sameStringArray(actualTargets, approval.targetPaths)) {
    reject('artifact-target-paths-do-not-match-approval')
  }
  assertTargetContainment(workspaceRoot, policy.productionCodePaths ?? [], approval.targetPaths)

  const dirty = await gitValue(
    workspaceRoot,
    ['status', '--porcelain', '--untracked-files=no'],
    'base-repository-unresolvable'
  )
  if (dirty.length > 0) reject('approved-mutation-base-is-dirty')
  if (approval.expectedBaseRevision !== undefined) {
    const revision = await gitValue(
      workspaceRoot,
      ['rev-parse', 'HEAD'],
      'base-revision-unresolvable'
    )
    if (revision !== approval.expectedBaseRevision) reject('base-revision-mismatch')
  }
  if (approval.expectedBaseTreeHash !== undefined) {
    const tree = await gitValue(
      workspaceRoot,
      ['rev-parse', 'HEAD^{tree}'],
      'base-tree-hash-unresolvable'
    )
    if (tree !== approval.expectedBaseTreeHash) reject('base-tree-hash-mismatch')
  }

  return {
    approvalRecordHash: approvalFile.pinnedHash ?? sha256(approvalFile.content),
    artifactContentHash: artifactHash,
    artifactPath: artifactFile.path,
    workspaceRoot,
    targetPaths: approval.targetPaths,
    ...(approval.expectedBaseRevision !== undefined
      ? { expectedBaseRevision: approval.expectedBaseRevision }
      : {}),
    ...(approval.expectedBaseTreeHash !== undefined
      ? { expectedBaseTreeHash: approval.expectedBaseTreeHash }
      : {}),
    approvedBy: evidence.approvedBy,
    approvedAt: evidence.approvedAt,
  }
}

function deterministicApplyPrompt(
  policy: HrcActuatorSplitPolicy,
  mutation: ResolvedApprovedMutation
): string {
  const approval = policy.approval
  if (!approval) reject('missing-approved-mutation-ref')
  return [
    'HRC deterministic actuator request (hrc.actuator-split-policy/v1).',
    'Apply only the approved immutable artifact below. Do not perform any other implementation, cleanup, commit, push, or target-path mutation.',
    `artifactKind: ${approval.artifactKind}`,
    `artifactPath: ${mutation.artifactPath}`,
    `artifactContentHash: sha256:${mutation.artifactContentHash}`,
    `approvalRecordHash: sha256:${mutation.approvalRecordHash}`,
    `workspaceRoot: ${mutation.workspaceRoot}`,
    `targetPaths: ${JSON.stringify(mutation.targetPaths)}`,
    ...(mutation.expectedBaseRevision
      ? [`expectedBaseRevision: ${mutation.expectedBaseRevision}`]
      : []),
    ...(mutation.expectedBaseTreeHash
      ? [`expectedBaseTreeHash: ${mutation.expectedBaseTreeHash}`]
      : []),
    'Recheck the base fence and artifact hash, then apply exactly this artifact. Fail closed on any mismatch.',
  ].join('\n')
}

function scrubReadOnlyCallerCredentials(intent: HrcRuntimeIntent): HrcRuntimeIntent {
  const source = intent.launch?.env
  if (!source) return intent
  const removed = Object.keys(source).filter(isCredentialEnvKey)
  if (removed.length === 0) return intent
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !isCredentialEnvKey(key)))
  const unsetEnv = [...new Set([...(intent.launch?.unsetEnv ?? []), ...removed])]
  return {
    ...intent,
    launch: {
      ...intent.launch,
      ...(Object.keys(env).length > 0 ? { env } : { env: undefined }),
      unsetEnv,
    },
  }
}

export async function prepareActuatorSplitIntent(
  intent: HrcRuntimeIntent
): Promise<PreparedActuatorSplitIntent> {
  const policy = effectivePolicy(intent)
  if (!policy || policy.mode === 'off') return { intent }

  if (policy.laneClass === 'actuator') {
    const approvedMutation = await resolveApprovedMutation(intent, policy)
    return {
      intent: {
        ...intent,
        execution: { ...intent.execution, actuatorSplit: policy },
        initialPrompt: deterministicApplyPrompt(policy, approvedMutation),
      },
      authority: { actuatorSplit: policy, approvedMutation },
    }
  }

  const scrubbed = scrubReadOnlyCallerCredentials(intent)
  return {
    intent: {
      ...scrubbed,
      execution: { ...scrubbed.execution, actuatorSplit: policy },
    },
    authority: { actuatorSplit: policy },
  }
}

export function assertActuatorSplitRouteAdmission(
  intent: HrcRuntimeIntent,
  route: ActuatorSplitRoute
): void {
  const policy = effectivePolicy(intent)
  if (!policy || policy.mode === 'off') return
  if (
    route !== 'broker' ||
    intent.harness.provider !== 'openai' ||
    intent.harness.interactive !== false ||
    (intent.harness.id !== undefined && intent.harness.id !== 'codex-cli')
  ) {
    reject('high-risk-route-requires-headless-codex-broker', { route })
  }
}

export async function assertActuatorSplitAdmission(input: {
  intent: HrcRuntimeIntent
  route: ActuatorSplitRoute
  startRequest?: InvocationStartRequest | undefined
  preparedAuthority?: ActuatorSplitAuthority | undefined
  runtime?: HrcRuntimeSnapshot | undefined
}): Promise<ActuatorSplitAuthority | undefined> {
  const policy = effectivePolicy(input.intent)
  if (!policy || policy.mode === 'off') {
    if (input.runtime) assertActuatorSplitRuntimeReuse(input.intent, input.runtime)
    return undefined
  }
  assertActuatorSplitRouteAdmission(input.intent, input.route)
  const startRequest = input.startRequest
  if (!startRequest) reject('hash-verified-start-request-required')
  if (startRequest.spec.driver.kind !== 'codex-app-server') {
    reject('high-risk-route-requires-codex-app-server')
  }
  const sandboxMode =
    startRequest.spec.driver.kind === 'codex-app-server'
      ? startRequest.spec.driver.sandboxMode
      : undefined
  if (policy.laneClass === 'actuator') {
    if (sandboxMode !== 'workspace-write') {
      reject('high-risk-actuator-requires-workspace-write-codex-app-server')
    }
  } else if (sandboxMode !== 'read-only') {
    reject('high-risk-verifier-requires-read-only-codex-app-server')
  }

  const authority =
    input.preparedAuthority ??
    (policy.laneClass === 'actuator'
      ? {
          actuatorSplit: policy,
          approvedMutation: await resolveApprovedMutation(input.intent, policy),
        }
      : { actuatorSplit: policy })
  if (input.runtime) assertActuatorSplitRuntimeReuse(input.intent, input.runtime)
  return authority
}

function runtimePolicy(runtime: HrcRuntimeSnapshot): unknown {
  const authority = runtime.runtimeStateJson?.['authority']
  return isRecord(authority) ? authority['actuatorSplit'] : undefined
}

export function assertActuatorSplitRuntimeReuse(
  intent: HrcRuntimeIntent,
  runtime: HrcRuntimeSnapshot
): void {
  const requested = effectivePolicy(intent)
  const persisted = normalizeActuatorSplitPolicy(runtimePolicy(runtime))
  const requestedEffective = requested?.mode === 'off' ? undefined : requested
  const persistedEffective = persisted?.mode === 'off' ? undefined : persisted
  if (JSON.stringify(requestedEffective) !== JSON.stringify(persistedEffective)) {
    reject('runtime-actuator-split-authority-mismatch', { runtimeId: runtime.runtimeId })
  }
}

export function actuatorSplitRuntimeAuthority(
  authority: ActuatorSplitAuthority | undefined
): Record<string, unknown> | undefined {
  if (!authority) return undefined
  return {
    actuatorSplit: authority.actuatorSplit,
    ...(authority.approvedMutation
      ? {
          approvedMutation: {
            approvalRecordHash: `sha256:${authority.approvedMutation.approvalRecordHash}`,
            artifactContentHash: `sha256:${authority.approvedMutation.artifactContentHash}`,
            targetPaths: authority.approvedMutation.targetPaths,
            ...(authority.approvedMutation.expectedBaseRevision
              ? { expectedBaseRevision: authority.approvedMutation.expectedBaseRevision }
              : {}),
            ...(authority.approvedMutation.expectedBaseTreeHash
              ? { expectedBaseTreeHash: authority.approvedMutation.expectedBaseTreeHash }
              : {}),
            approvedBy: authority.approvedMutation.approvedBy,
            approvedAt: authority.approvedMutation.approvedAt,
          },
        }
      : {}),
  }
}

/**
 * Project only the non-secret, effective actuator authority for operator
 * inspection. Approval/artifact refs are deliberately omitted: operators need
 * the immutable hashes, fences, and path scope, not local storage locations.
 */
export function projectActuatorSplitInspectAuthority(
  runtimeStateJson: Record<string, unknown> | undefined
): HrcActuatorSplitAuthorityView | undefined {
  const rawAuthority = runtimeStateJson?.['authority']
  if (!isRecord(rawAuthority)) return undefined

  let policy: HrcActuatorSplitPolicy | undefined
  try {
    policy = normalizeActuatorSplitPolicy(rawAuthority['actuatorSplit'])
  } catch {
    return undefined
  }
  if (!policy || policy.mode === 'off') return undefined

  const { approval: _approval, ...actuatorSplit } = policy
  const rawApprovedMutation = rawAuthority['approvedMutation']
  if (!isRecord(rawApprovedMutation)) {
    return { actuatorSplit }
  }

  const approvalRecordHash = rawApprovedMutation['approvalRecordHash']
  const artifactContentHash = rawApprovedMutation['artifactContentHash']
  const targetPaths = rawApprovedMutation['targetPaths']
  if (
    typeof approvalRecordHash !== 'string' ||
    typeof artifactContentHash !== 'string' ||
    !Array.isArray(targetPaths) ||
    targetPaths.some((path) => typeof path !== 'string')
  ) {
    return { actuatorSplit }
  }

  const expectedBaseRevision = rawApprovedMutation['expectedBaseRevision']
  const expectedBaseTreeHash = rawApprovedMutation['expectedBaseTreeHash']
  const approvedBy = rawApprovedMutation['approvedBy']
  const approvedAt = rawApprovedMutation['approvedAt']
  return {
    actuatorSplit,
    approvedMutation: {
      approvalRecordHash,
      artifactContentHash,
      targetPaths: targetPaths.map(String),
      ...(typeof expectedBaseRevision === 'string' ? { expectedBaseRevision } : {}),
      ...(typeof expectedBaseTreeHash === 'string' ? { expectedBaseTreeHash } : {}),
      ...(typeof approvedBy === 'string' ? { approvedBy } : {}),
      ...(typeof approvedAt === 'string' ? { approvedAt } : {}),
    },
  }
}
