import { describe, expect, it } from 'bun:test'

import { execProcess } from '../exec-process.js'

describe('turn execProcess', () => {
  it('captures stdout, stderr, and exit code', async () => {
    const result = await execProcess([
      process.execPath,
      '-e',
      "console.log('out'); console.error('err'); process.exit(7)",
    ])

    expect(result).toEqual({ stdout: 'out\n', stderr: 'err\n', exitCode: 7 })
  })
})
