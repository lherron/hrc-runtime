import { describe, expect, it } from 'bun:test'

import { scanEnvFile } from './check-env-hygiene.js'

describe('env-hygiene scan', () => {
  it('flags credentials while accepting empty and context-only files', () => {
    const content = [
      'WRKQ_PROJECT_ROOT=hrc-runtime',
      'WRKQ_DB_PATH=/tmp/wrkq.db',
      'WRKQD_TOKEN=dev',
      'WRKQ_ACTOR=local-human',
      'CP_TOKEN=dev',
      'CP_PORT=18420',
      'WRKQD_TOKEN_FILE=~/.config/wrkq/node-token',
      '# WRKQD_TOKEN=commented-out',
    ].join('\n')

    expect(scanEnvFile(content).sort()).toEqual(['CP_TOKEN', 'WRKQD_TOKEN', 'WRKQ_ACTOR'])
    expect(scanEnvFile('')).toEqual([])
    expect(scanEnvFile('ASP_HOME=/x\nTOOL_STACK=dev\n')).toEqual([])
  })
})
