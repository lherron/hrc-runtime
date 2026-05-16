import { spawn } from 'node:child_process'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import {
  type AgentBrainRuntimeContext,
  type BrainRuntimeResolution,
  detectAgentLocalComponents,
  resolveAgentBrainRuntime,
} from 'spaces-execution'

import { getBrainSessionCache } from './cache.js'
import {
  type BrainContextSource,
  type BrainRule,
  contextSourcesForResult,
  formatBrainPrompt,
} from './format.js'

export interface BrainEnricherInput {
  session: HrcSessionRecord
  intent: HrcRuntimeIntent
  prompt: string
  runId?: string | undefined
}

export interface BrainEnricherResult {
  prompt: string
  applied: boolean
  reason:
    | 'enabled'
    | 'disabled'
    | 'injection-disabled'
    | 'resolution-error'
    | 'query-timeout'
    | 'empty-prompt'
    | 'non-agent-scope'
  sources?: ReadonlyArray<{ slug: string; score: number }> | undefined
}

export type GbrainRunner = (
  argv: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number }
) => Promise<GbrainRunnerResult>

export type GbrainRunnerResult = {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean | undefined
}

export type BrainRuntimeResolver = (
  context: AgentBrainRuntimeContext,
  baseEnv?: Record<string, string> | undefined
) => Promise<BrainRuntimeResolution>

type BrainEnricherDeps = {
  gbrainRunner?: GbrainRunner | undefined
  brainRuntimeResolver?: BrainRuntimeResolver | undefined
}

type ParsedContextSource = BrainContextSource & {
  status?: string | undefined
  type?: string | undefined
}

type ParsedBrainRule = BrainRule & {
  status?: string | undefined
}

const GBRAIN_TIMEOUT_MS = 2500
const QUERY_LIMIT = 5
const QUERY_MAX_TOKENS = 800

export async function enrichTurnPromptForBrain(
  input: BrainEnricherInput,
  deps: BrainEnricherDeps = {}
): Promise<BrainEnricherResult> {
  if (!input.session.scopeRef.startsWith('agent:')) {
    return passThrough(input.prompt, 'non-agent-scope')
  }

  if (input.prompt.trim().length === 0) {
    return passThrough(input.prompt, 'empty-prompt')
  }

  const agentRoot = input.intent.placement.agentRoot
  const cache = getBrainSessionCache({
    hostSessionId: input.session.hostSessionId,
    scopeRef: input.session.scopeRef,
    agentRoot,
  })

  try {
    cache.resolution ??= resolveBrainRuntime(input.intent, deps.brainRuntimeResolver)
    const resolution = await cache.resolution

    if (resolution.kind === 'disabled') {
      return passThrough(input.prompt, 'disabled')
    }
    if (resolution.kind !== 'enabled') {
      return passThrough(input.prompt, 'resolution-error')
    }
    if (resolution.injection === false) {
      return passThrough(input.prompt, 'injection-disabled')
    }

    const queryKey = `${resolution.GBRAIN_HOME}\0${resolution.BRAIN_REPO}\0${input.prompt}`
    const cachedQuery = cache.queryResults.get(queryKey)
    if (cachedQuery) {
      return await cachedQuery
    }

    const query = queryGbrain(input.prompt, resolution, deps.gbrainRunner ?? defaultGbrainRunner)
    cache.queryResults.set(queryKey, query)
    return await query
  } catch {
    return passThrough(input.prompt, 'resolution-error')
  }
}

async function resolveBrainRuntime(
  intent: HrcRuntimeIntent,
  resolver: BrainRuntimeResolver = resolveAgentBrainRuntime
): Promise<BrainRuntimeResolution> {
  const components = await detectAgentLocalComponents(intent.placement.agentRoot)
  const context: AgentBrainRuntimeContext = {
    agentRoot: intent.placement.agentRoot,
    ...(components ? { components } : {}),
  }
  return await resolver(context, envRecord(process.env))
}

async function queryGbrain(
  prompt: string,
  resolution: Extract<BrainRuntimeResolution, { kind: 'enabled' }>,
  runner: GbrainRunner
): Promise<BrainEnricherResult> {
  const started = Date.now()
  const env = { ...envRecord(process.env), ...resolution.env }
  const queryArgs = [
    'query',
    '--json',
    '--limit',
    String(QUERY_LIMIT),
    '--max-tokens',
    String(QUERY_MAX_TOKENS),
    prompt,
  ]

  const [queryResult, rulesResult] = await Promise.all([
    runner(queryArgs, { env, timeoutMs: GBRAIN_TIMEOUT_MS }),
    runner(
      [
        'list',
        '--type',
        'guide',
        '--where',
        'subtype=operational-rule',
        '--where',
        'status=active',
        '--json',
      ],
      { env, timeoutMs: GBRAIN_TIMEOUT_MS }
    ),
  ])

  if (queryResult.timedOut || rulesResult.timedOut) {
    return passThrough(prompt, 'query-timeout')
  }

  if (queryResult.exitCode !== 0 || rulesResult.exitCode !== 0) {
    return passThrough(prompt, 'resolution-error')
  }

  const rules = parseRules(rulesResult.stdout)
  const context = filterContext(parseContextSources(queryResult.stdout))
  const enrichedPrompt = formatBrainPrompt(prompt, {
    rules,
    context,
    elapsedMs: Date.now() - started,
  })

  return {
    prompt: enrichedPrompt,
    applied: true,
    reason: 'enabled',
    sources: contextSourcesForResult(context),
  }
}

async function defaultGbrainRunner(
  argv: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number }
): Promise<GbrainRunnerResult> {
  return await new Promise((resolve) => {
    const child = spawn('gbrain', [...argv], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill('SIGKILL')
      resolve({ stdout, stderr, exitCode: -1, timedOut: true })
    }, options.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr: error.message, exitCode: -1 })
    })
    child.on('close', (exitCode) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 })
    })
  })
}

function parseContextSources(stdout: string): BrainContextSource[] {
  const fromJson = parseContextSourcesFromJson(stdout)
  if (fromJson.length > 0) {
    return fromJson
  }
  return parseContextSourcesFromText(stdout)
}

function parseContextSourcesFromJson(stdout: string): BrainContextSource[] {
  const values = normalizeJsonRows(parseJsonOutput(stdout))
  return values
    .map((value): ParsedContextSource | undefined => {
      if (!isRecord(value)) {
        return undefined
      }
      const slug = stringField(value, ['slug', 'path', 'id', 'page'])
      if (!slug) {
        return undefined
      }
      const text = stringField(value, ['snippet', 'text', 'content', 'summary', 'body']) ?? ''
      return {
        slug,
        score: numberField(value, ['score', 'rank', 'rrf_score', 'similarity']) ?? 0,
        text,
        ...(stringField(value, ['status']) !== undefined
          ? { status: stringField(value, ['status']) }
          : {}),
        ...(stringField(value, ['type']) !== undefined
          ? { type: stringField(value, ['type']) }
          : {}),
      }
    })
    .filter((value): value is ParsedContextSource => value !== undefined)
}

function parseContextSourcesFromText(stdout: string): BrainContextSource[] {
  const trimmed = stdout.trim()
  if (trimmed.length === 0 || trimmed === 'No results.' || trimmed === 'No pages found.') {
    return []
  }
  const headerRe = /^\[([\d.]+)\]\s+(\S+)\s+--\s+#\s*(.*)$/
  const results: ParsedContextSource[] = []
  let current: ParsedContextSource | null = null
  let snippet: string[] = []
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.replace(/\s*\(stale\)\s*$/, '')
    const match = line.match(headerRe)
    if (match && match[1] !== undefined && match[2] !== undefined) {
      if (current) {
        current.text = snippet.join(' ').trim().slice(0, 200)
        results.push(current)
      }
      current = {
        slug: match[2],
        score: Number.parseFloat(match[1]),
        text: '',
      }
      snippet = []
    } else if (current && line.trim().length > 0) {
      snippet.push(line.trim())
    }
  }
  if (current) {
    current.text = snippet.join(' ').trim().slice(0, 200)
    results.push(current)
  }
  return results
}

function parseRules(stdout: string): BrainRule[] {
  const values = normalizeJsonRows(parseJsonOutput(stdout))
  return values
    .map((value): ParsedBrainRule | undefined => {
      if (!isRecord(value)) {
        return undefined
      }
      const text = stringField(value, ['rule', 'text', 'content', 'summary', 'title'])
      if (!text) {
        return undefined
      }
      const slug = stringField(value, ['slug', 'path', 'id', 'page'])
      const title = stringField(value, ['title'])
      const score = numberField(value, ['score', 'rank'])
      const status = stringField(value, ['status'])
      return {
        ...(slug !== undefined ? { slug } : {}),
        ...(title !== undefined ? { title } : {}),
        text,
        ...(score !== undefined ? { score } : {}),
        ...(status !== undefined ? { status } : {}),
      }
    })
    .filter(
      (rule): rule is ParsedBrainRule =>
        !!rule && (rule.status === undefined || rule.status === 'active')
    )
    .slice(0, 5)
}

function filterContext(sources: ParsedContextSource[]): BrainContextSource[] {
  return sources
    .filter((source) => {
      const type = source.type ?? source.slug.split('/')[0] ?? ''
      const status = source.status
      if (type === 'decisions' || type === 'rules') {
        return status === undefined || status === 'active'
      }
      if (type === 'patterns' || type === 'arch') {
        return status === undefined || status === 'accepted'
      }
      if (type === 'synthesis') {
        return status === undefined || status === 'reviewed'
      }
      return true
    })
    .slice(0, QUERY_LIMIT)
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (trimmed.length === 0 || trimmed === 'No results.' || trimmed === 'No pages found.') {
    return []
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return []
  }
}

function normalizeJsonRows(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  if (!isRecord(value)) {
    return []
  }
  for (const key of ['results', 'items', 'pages', 'data']) {
    const rows = value[key]
    if (Array.isArray(rows)) {
      return rows
    }
  }
  return [value]
}

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === 'string' && field.trim().length > 0) {
      return field.trim()
    }
  }
  return undefined
}

function numberField(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === 'number' && Number.isFinite(field)) {
      return field
    }
    if (typeof field === 'string') {
      const parsed = Number(field)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

function passThrough(prompt: string, reason: BrainEnricherResult['reason']): BrainEnricherResult {
  return { prompt, applied: false, reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      record[key] = value
    }
  }
  return record
}
