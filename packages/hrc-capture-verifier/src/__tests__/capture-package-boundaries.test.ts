import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
describe('package boundaries', () => {
  it('keeps hrc-store-sqlite out of the root public API implementation', () => {
    const rootSources = [
      'src/index.ts',
      'src/provider-transcript.ts',
      'src/verifier.ts',
      'src/types.ts',
    ]
    for (const relativePath of rootSources) {
      const source = readFileSync(resolve(import.meta.dir, '..', '..', relativePath), 'utf8')
      expect(source).not.toContain('hrc-store-sqlite')
      expect(source).not.toContain('hrc-server')
      expect(source).not.toContain('hrc-cli')
      expect(source).not.toContain('gateway-discord')
    }
  })
})
