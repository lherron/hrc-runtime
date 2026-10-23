import { readFileSync, writeFileSync } from 'node:fs'
const [input, output] = process.argv.slice(2)
const lines = readFileSync(input, 'utf8').trimEnd().split('\n')
const results = lines.map((line) => {
  try {
    return JSON.stringify(JSON.parse(line))
  } catch {
    return 'INVALID_JSON'
  }
})
writeFileSync(output, `${results.join('\n')}\n`)
