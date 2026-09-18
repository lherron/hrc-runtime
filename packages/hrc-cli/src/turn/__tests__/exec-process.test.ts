import { afterAll, describe, expect, it } from 'bun:test'

import { installOldEngineDaemon } from '../../__tests__/old-engine-daemon.js'
import { execProcess } from '../exec-process.js'

const oldEngineDaemon = installOldEngineDaemon()
afterAll(() => oldEngineDaemon.stop())

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
