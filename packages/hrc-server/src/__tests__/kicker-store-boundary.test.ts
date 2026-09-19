import { expect, it } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

async function productionSource(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        return entry.name === '__tests__' ? [] : productionSource(path)
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [await readFile(path, 'utf8')] : []
    })
  )
  return files.flat()
}

it('keeps moved delivery-table writers out of the HRC server', async () => {
  const sourceDirectory = fileURLToPath(new URL('..', import.meta.url))
  const sources = await productionSource(sourceDirectory)
  const mailDeliveryMethods = sources
    .flatMap((source) => [...source.matchAll(/\b(?:this|server)\.db\.mailDelivery\.(\w+)/g)])
    .map((match) => match[1])
    .sort()

  // Seat hints remain HRC state. Every delivery intent, presentation, refusal,
  // expiry, failure notice, and ledger cursor is owned by the kicker store.
  expect(mailDeliveryMethods).toEqual(['evaluateSeatHint'])
})
