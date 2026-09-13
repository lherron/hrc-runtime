import { describe, expect, test } from 'bun:test'

import { createToolResultSpillStub } from './tool-result-storage.js'

const spill = {
  blobId: 'tc:runtime:tool',
  bytes: 1_100_000,
  kind: 'broker_raw' as const,
}

describe('bounded tool-result spill stubs', () => {
  test('keeps only allowlisted scalar diagnostics from details and top level', () => {
    const stub = createToolResultSpillStub(
      {
        content: [{ type: 'text', text: 'short output' }],
        status: 'completed',
        duration: 1.25,
        response: 'x'.repeat(20_000),
        details: {
          stdout: 'x'.repeat(1_000_000),
          file: { base64: 'y'.repeat(680_000) },
          exitCode: 0,
          interrupted: false,
          durationMs: 1250,
          status: ['not', 'scalar'],
        },
      },
      spill
    )

    expect(stub.details).toEqual({
      exitCode: 0,
      status: 'completed',
      interrupted: false,
      duration: 1.25,
      durationMs: 1250,
      spill,
    })
    expect(Buffer.byteLength(JSON.stringify(stub))).toBeLessThan(8_000)
  })

  test('caps allowlisted strings by UTF-8 bytes', () => {
    const stub = createToolResultSpillStub({ output: 'body', status: '🫠'.repeat(200) }, spill)
    const status = stub.details?.['status']
    expect(typeof status).toBe('string')
    expect(Buffer.byteLength(status as string, 'utf8')).toBe(256)
  })

  test('re-stubbing preserves the existing excerpt and removes bulk fields', () => {
    const content = [{ type: 'text' as const, text: 'existing excerpt' }]
    const stub = createToolResultSpillStub(
      {
        content,
        details: {
          spill,
          stdout: 'x'.repeat(1_000_000),
          exitCode: 7,
        },
      },
      spill,
      { preserveExistingExcerpt: true }
    )

    expect(stub).toEqual({ content, details: { exitCode: 7, spill } })
  })
})
