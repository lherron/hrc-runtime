import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyDotEnvFile,
  isCredentialClassKey,
  loadDotEnvLocal,
  parseDotEnvContent,
  warnAutoLoadedCredentials,
} from './dotenv-local.js'

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'hrc-dotenv-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('isCredentialClassKey', () => {
  it('classifies credentials, principals, and *_FILE indirection', () => {
    expect(isCredentialClassKey('WRKQD_TOKEN')).toBe(true)
    expect(isCredentialClassKey('CP_TOKEN')).toBe(true)
    expect(isCredentialClassKey('SOME_SECRET')).toBe(true)
    expect(isCredentialClassKey('DB_PASSWORD')).toBe(true)
    expect(isCredentialClassKey('OPENAI_API_KEY')).toBe(true)
    expect(isCredentialClassKey('SERVICE_AUTH_TOKEN')).toBe(true)
    expect(isCredentialClassKey('WRKQ_ACTOR')).toBe(true)
    expect(isCredentialClassKey('WRKQD_TOKEN_FILE')).toBe(false)
    expect(isCredentialClassKey('WRKQ_PROJECT_ROOT')).toBe(false)
    expect(isCredentialClassKey('WRKQ_DB_PATH')).toBe(false)
    expect(isCredentialClassKey('CP_PORT')).toBe(false)
  })
})

describe('applyDotEnvFile', () => {
  it('applies context keys, refuses credential keys with one warning', () => {
    const { root, cleanup } = fixture()
    try {
      const envPath = join(root, '.env.local')
      writeFileSync(
        envPath,
        'WRKQ_PROJECT_ROOT=hrc-runtime\nWRKQD_TOKEN=dev\nWRKQ_ACTOR=local-human\n# comment\n'
      )
      const env: Record<string, string | undefined> = {}
      const warnings: string[] = []
      applyDotEnvFile(envPath, env, (m) => warnings.push(m))

      expect(env['WRKQ_PROJECT_ROOT']).toBe('hrc-runtime')
      expect(env['WRKQD_TOKEN']).toBeUndefined()
      expect(env['WRKQ_ACTOR']).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('WRKQD_TOKEN, WRKQ_ACTOR')
      expect(warnings[0]).not.toContain('dev')
    } finally {
      cleanup()
    }
  })

  it('never overwrites real environment variables', () => {
    const { root, cleanup } = fixture()
    try {
      const envPath = join(root, '.env.local')
      writeFileSync(envPath, 'WRKQ_PROJECT_ROOT=from-file\n')
      const env: Record<string, string | undefined> = { WRKQ_PROJECT_ROOT: 'from-env' }
      applyDotEnvFile(envPath, env, () => {})
      expect(env['WRKQ_PROJECT_ROOT']).toBe('from-env')
    } finally {
      cleanup()
    }
  })
})

describe('warnAutoLoadedCredentials', () => {
  it('warns when a credential env value byte-matches the cwd env file', () => {
    const { root, cleanup } = fixture()
    try {
      writeFileSync(join(root, '.env.local'), 'WRKQD_TOKEN=dev\nCP_PORT=18420\n')
      const warnings: string[] = []
      warnAutoLoadedCredentials(root, { WRKQD_TOKEN: 'dev' }, (m) => warnings.push(m))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('WRKQD_TOKEN')
      expect(warnings[0]).toContain('.env.local')
    } finally {
      cleanup()
    }
  })

  it('stays silent when values differ or the var is absent', () => {
    const { root, cleanup } = fixture()
    try {
      writeFileSync(join(root, '.env.local'), 'WRKQD_TOKEN=dev\n')
      const warnings: string[] = []
      warnAutoLoadedCredentials(root, { WRKQD_TOKEN: 'real-operator-token' }, (m) =>
        warnings.push(m)
      )
      warnAutoLoadedCredentials(root, {}, (m) => warnings.push(m))
      expect(warnings).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})

describe('loadDotEnvLocal', () => {
  it('walks up to the git root, nearer files win, credentials refused throughout', () => {
    const { root, cleanup } = fixture()
    try {
      mkdirSync(join(root, '.git'))
      mkdirSync(join(root, 'sub', 'inner'), { recursive: true })
      writeFileSync(join(root, '.env.local'), 'ASP_PROJECT=outer\nSHARED=outer\nWRKQD_TOKEN=dev\n')
      writeFileSync(join(root, 'sub', 'inner', '.env.local'), 'SHARED=inner\n')

      const env: Record<string, string | undefined> = {}
      const warnings: string[] = []
      loadDotEnvLocal({ cwd: join(root, 'sub', 'inner'), env, warn: (m) => warnings.push(m) })

      expect(env['SHARED']).toBe('inner')
      expect(env['ASP_PROJECT']).toBe('outer')
      expect(env['WRKQD_TOKEN']).toBeUndefined()
      expect(warnings.some((m) => m.includes('refusing credential-class'))).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe('parseDotEnvContent', () => {
  it('skips comments, blanks, and eq-less lines', () => {
    expect(parseDotEnvContent('# c\n\nKEY=v\nnoise\nA=b=c\n')).toEqual({
      KEY: 'v',
      A: 'b=c',
    })
  })
})
