import { QUESTIONS } from './questions.js'

export const CLASSIFIER_VERSION = 'attention-v3'
export const STATES = ['blocking', 'decision', 'offer', 'none'] as const
export type State = (typeof STATES)[number]
export type TurnText = {
  agent: string
  project: string
  seat: string
  user_text_tail: string
  final_text: string
}
// Array.from preserves Unicode code points, matching Python's frozen harness slices.
export const tail = (text: string, limit: number) => Array.from(text).slice(-limit).join('')
/** turn.attention `text`: the whole final message, at most TEXT_BYTES of UTF-8. A longer message
 * keeps its tail (the ask is usually at the end) behind a leading "…". */
export const TEXT_BYTES = 16384
const utf8 = new TextEncoder()
export function capText(text: string): string {
  if (utf8.encode(text).length <= TEXT_BYTES) return text
  const points = Array.from(text)
  let bytes = utf8.encode('…').length
  let start = points.length
  while (start > 0) {
    const next = utf8.encode(points[start - 1]!).length
    if (bytes + next > TEXT_BYTES) break
    bytes += next
    start--
  }
  return `…${points.slice(start).join('')}`
}
export function buildRequest(turn: TurnText) {
  return {
    model: 'jev-latest',
    state: {
      agent: turn.agent,
      project: turn.project,
      seat: turn.seat,
      turn_user: tail(turn.user_text_tail, 400),
      final_text: tail(turn.final_text, 2500),
    },
    questions: QUESTIONS,
  }
}
const probability = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('invalid classifier probability')
  }
  return value
}
export async function classify(turn: TurnText, key: string, request = fetch) {
  const started = performance.now()
  const response = await request('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRequest(turn)),
    signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) throw new Error(`jev HTTP ${response.status}`)
  const out = (await response.json()) as {
    model: string
    answers: {
      ask: { probabilities: Record<State, number>; confidence: number }
      kind: { choice: string }
      to_lance: { noul: number }
      waiting_on_other: { noul: number }
    }
  }
  const a = out.answers
  const p = Object.fromEntries(
    STATES.map((s) => [s, probability(a.ask.probabilities[s])])
  ) as Record<State, number>
  const lit = p.blocking + p.decision >= 0.5
  // A lit turn must carry a lit state: blocking and decision can split the
  // vote so that none wins the argmax while their sum lights the turn, and
  // consumers act on state, not on p.
  const state: State = lit
    ? p.decision > p.blocking
      ? 'decision'
      : 'blocking'
    : STATES.reduce((best, s) => (p[s] > p[best] ? s : best))
  if (
    !['decision', 'approval', 'information', 'human_action', 'review', 'none'].includes(
      a.kind.choice
    )
  ) {
    throw new Error('invalid classifier kind')
  }
  if (typeof out.model !== 'string' || !out.model) throw new Error('missing classifier model')
  return {
    lit,
    state,
    kind: a.kind.choice,
    p,
    confidence: probability(a.ask.confidence),
    toLance: probability(a.to_lance.noul),
    waitingOnOther: probability(a.waiting_on_other.noul),
    excerpt: tail(turn.final_text, 240),
    text: capText(turn.final_text),
    model: out.model,
    classifierVersion: CLASSIFIER_VERSION,
    latencyMs: Math.round(performance.now() - started),
  }
}
