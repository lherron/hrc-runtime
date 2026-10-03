import { describe, expect, test } from 'bun:test'

import { injectRuntimeWrkqAuthority } from '../federation/wrkq-authority.js'
import { buildManagedBrokerDispatchEnv } from '../managed-broker-runtime-env.js'

const WRKQ_AUTHORITY_SOURCE = {
  HRC_WRKQ_DB: 'rpc://canonical.example:7171',
  HRC_WRKQD_TOKEN_FILE: '/run/secrets/wrkq-node-token',
}

describe('T-05562 managed broker wrkq authority', () => {
  test('managed broker projects locator/token authority and the mail stop socket', () => {
    const env = buildManagedBrokerDispatchEnv({
      baseEnv: {
        KEEP: 'yes',
        WRKQ_DB: '/tmp/caller-selected.sqlite',
        WRKQ_DB_PATH: '/tmp/stale.sqlite',
        WRKQ_DB_PATH_FILE: '/tmp/stale-path-file',
        WRKQD_TOKEN: 'stale-inline-token',
      },
      mailStopSocket: '/run/hrc.sock',
      wrkqAuthoritySource: WRKQ_AUTHORITY_SOURCE,
    })

    expect(env).toMatchObject({
      KEEP: 'yes',
      WRKQ_DB: WRKQ_AUTHORITY_SOURCE.HRC_WRKQ_DB,
      WRKQ_DB_PATH: '',
      WRKQ_DB_PATH_FILE: '',
      WRKQD_TOKEN_FILE: WRKQ_AUTHORITY_SOURCE.HRC_WRKQD_TOKEN_FILE,
      HRC_MAIL_STOP_SOCKET: '/run/hrc.sock',
    })
    expect(env).not.toHaveProperty('WRKQD_TOKEN')
    expect(Object.values(env)).not.toContain('stale-inline-token')
  })

  test('a local canonical locator still uses WRKQ_DB and clears path aliases', () => {
    expect(
      injectRuntimeWrkqAuthority(
        {
          WRKQ_DB_PATH: '/tmp/stale.sqlite',
          WRKQ_DB_PATH_FILE: '/tmp/stale-path-file',
        },
        { HRC_WRKQ_DB: '/var/lib/praesidium/wrkq.sqlite' }
      )
    ).toEqual({
      WRKQ_DB: '/var/lib/praesidium/wrkq.sqlite',
      WRKQ_DB_PATH: '',
      WRKQ_DB_PATH_FILE: '',
    })
  })
})
