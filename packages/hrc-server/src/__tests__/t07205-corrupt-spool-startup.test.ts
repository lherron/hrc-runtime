import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type HrcServerInstance, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

describe('T-07205 corrupt launch spool startup', () => {
  let fixture: HrcServerTestFixture | undefined
  let server: HrcServerInstance | undefined

  afterEach(async () => {
    await server?.stop()
    await fixture?.cleanup()
    server = undefined
    fixture = undefined
  })

  test('a truncated spool entry is quarantined without preventing the listener from starting', async () => {
    fixture = await createHrcTestFixture('hrc-corrupt-spool-')
    const launchId = 'launch-truncated'
    const truncated = '{"endpoint":"/v1/internal/hooks/ingest","payload":'
    const launchSpoolDir = join(fixture.spoolDir, launchId)
    await mkdir(launchSpoolDir, { recursive: true })
    await writeFile(join(launchSpoolDir, '000001.json'), truncated)

    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const status = await fixture.fetchSocket('/v1/status')
    expect(status.status).toBe(200)

    const quarantineDir = join(fixture.spoolDir, '.corrupt', launchId)
    const quarantined = await readdir(quarantineDir)
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toStartWith('000001.json.corrupt-')
    expect(await readFile(join(quarantineDir, quarantined[0]), 'utf-8')).toBe(truncated)
  })
})
