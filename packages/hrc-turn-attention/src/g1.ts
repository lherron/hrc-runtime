import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type TurnText, classify } from './classifier.js'

const fixture = process.argv[2] ?? join(import.meta.dir, '../fixtures/attention-gold.jsonl')
const output = process.argv[3] ?? join(import.meta.dir, '../fixtures')
const key = process.env['TYPESAFE_API_KEY']
if (!key) throw new Error('TYPESAFE_API_KEY is required')
const gold = (await readFile(fixture, 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as TurnText & { id: number; label: string })
// Eight independent gold calls at a time; never retry a failed call.
const results: Record<string, unknown>[] = new Array(gold.length)
let next = 0
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < gold.length) {
      const index = next++
      const turn = gold[index]
      if (!turn) throw new Error(`missing gold row ${index}`)
      try {
        results[index] = { id: turn.id, gold: turn.label, ...(await classify(turn, key)) }
      } catch (error) {
        results[index] = { id: turn.id, gold: turn.label, error: String(error) }
      }
    }
  })
)
const positive = (r: Record<string, unknown>) =>
  ['blocking', 'decision'].includes(String(r['gold']))
const tp = results.filter((r) => r['lit'] && positive(r)).length
const fp = results.filter((r) => r['lit'] && !positive(r)).length
const fn = results.filter((r) => !r['lit'] && positive(r)).length
const idleIds = [32264, 33946, 39314, 41975, 42603, 42686]
const idleDark = idleIds.every((id) => results.some((r) => r['id'] === id && r['lit'] === false))
const precision = tp / Math.max(1, tp + fp)
const recall = tp / Math.max(1, tp + fn)
const errors = results.filter((r) => r['error']).length
const passed = gold.length === 412 && errors === 0 && precision >= 0.9 && recall >= 0.85 && idleDark
const summary = {
  passed,
  count: results.length,
  tp,
  fp,
  fn,
  precision,
  recall,
  idleDark,
  idleIds,
  errors,
  classifierVersion: 'attention-v3',
  threshold: 0.5,
}
await mkdir(output, { recursive: true })
await writeFile(
  join(output, 'g1-results.jsonl'),
  `${results.map((r) => JSON.stringify(r)).join('\n')}\n`
)
await writeFile(join(output, 'g1-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary))
if (!passed) process.exitCode = 1
