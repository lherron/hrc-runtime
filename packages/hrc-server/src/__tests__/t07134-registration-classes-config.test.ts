import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HRC_REGISTRATION_CLASSES_FILE_ENV,
  loadRegistrationClassesFromEnv,
  parseRegistrationClassesConfig,
} from '../registration-classes-config.js'

describe('T-07134 registration class config', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  })

  const arrisClass = {
    classId: 'arris-agent',
    scopeTemplate: { agent: 'arris', project: 'arris' },
    maxInstances: 2,
    defaultTtl: 60,
    turnsAllowed: false,
  }

  test('loads operator-ratified classes from the daemon-owned config file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-registration-classes-'))
    const configPath = join(tempDir, 'registration-classes.json')
    await writeFile(configPath, JSON.stringify([arrisClass]))

    expect(
      await loadRegistrationClassesFromEnv({
        [HRC_REGISTRATION_CLASSES_FILE_ENV]: configPath,
      })
    ).toEqual([arrisClass])
  })

  test('refuses duplicate classes and malformed templates at daemon startup', () => {
    expect(() => parseRegistrationClassesConfig([arrisClass, arrisClass], 'test config')).toThrow(
      'duplicate classId'
    )
    expect(() =>
      parseRegistrationClassesConfig(
        [{ ...arrisClass, scopeTemplate: { agent: 'arris', project: 'bad:project' } }],
        'test config'
      )
    ).toThrow('project is invalid')
    expect(() =>
      parseRegistrationClassesConfig([{ ...arrisClass, defaultTtl: 301 }], 'test config')
    ).toThrow('must not exceed 300')
  })
})
