export type BrainRule = {
  slug?: string | undefined
  title?: string | undefined
  text: string
  score?: number | undefined
}

export type BrainContextSource = {
  slug: string
  score: number
  text: string
}

const MAX_RULES = 5
const MAX_CONTEXT = 5
const MAX_SNIPPET_CHARS = 200
const MAX_CONTEXT_CHARS = 3200

export function formatBrainPrompt(
  prompt: string,
  options: {
    rules: readonly BrainRule[]
    context: readonly BrainContextSource[]
    elapsedMs: number
  }
): string {
  const rulesText = options.rules
    .slice(0, MAX_RULES)
    .map((rule) => sanitizeBlockText(rule.text))
    .filter((rule) => rule.length > 0)
    .join('\n')
  const sources = cappedContext(options.context)
  const contextText = sources
    .map(
      (source) =>
        `<source slug="${escapeAttribute(source.slug)}" score="${formatScore(source.score)}">\n${sanitizeBlockText(source.text)}\n</source>`
    )
    .join('\n')

  return `${prompt}

<brain_rules>
${rulesText}
</brain_rules>
<brain_context source="gbrain" mode="query" results="${sources.length}" elapsed_ms="${Math.max(
    0,
    Math.round(options.elapsedMs)
  )}">
${contextText}
</brain_context>`
}

export function contextSourcesForResult(
  sources: readonly BrainContextSource[]
): ReadonlyArray<{ slug: string; score: number }> {
  return sources.map((source) => ({ slug: source.slug, score: source.score }))
}

function cappedContext(sources: readonly BrainContextSource[]): BrainContextSource[] {
  const capped: BrainContextSource[] = []
  let used = 0

  for (const source of sources.slice(0, MAX_CONTEXT)) {
    const snippet = snippetText(source.text)
    if (snippet.length === 0) {
      continue
    }

    if (used + snippet.length > MAX_CONTEXT_CHARS) {
      const remaining = MAX_CONTEXT_CHARS - used
      if (remaining <= 0) {
        break
      }
      capped.push({ ...source, text: snippet.slice(0, remaining).trimEnd() })
      break
    }

    capped.push({ ...source, text: snippet })
    used += snippet.length
  }

  return capped
}

function snippetText(text: string): string {
  const normalized = sanitizeBlockText(text).replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_SNIPPET_CHARS) {
    return normalized
  }
  return normalized.slice(0, MAX_SNIPPET_CHARS).trimEnd()
}

function sanitizeBlockText(text: string): string {
  return text.replaceAll('</brain_rules>', '').replaceAll('</brain_context>', '').trim()
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function formatScore(score: number): string {
  if (!Number.isFinite(score)) {
    return '0'
  }
  return Number(score.toFixed(4)).toString()
}
