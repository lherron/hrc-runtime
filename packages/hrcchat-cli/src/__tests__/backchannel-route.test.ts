import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SemanticDmRequest, SemanticDmResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { assertBackchannelFollowAllowed } from '../backchannel-route.js'
import { cmdDm } from '../commands/dm.js'

const savedEnv = {
  BACKCHANNEL_BYPASS: process.env['BACKCHANNEL_BYPASS'],
  BACKCHANNEL_DIR: process.env['BACKCHANNEL_DIR'],
  BACKCHANNEL_NODE: process.env['BACKCHANNEL_NODE'],
  BACKCHANNEL_TEST_LOG: process.env['BACKCHANNEL_TEST_LOG'],
  ASP_PROJECT: process.env['ASP_PROJECT'],
  HRC_SESSION_REF: process.env['HRC_SESSION_REF'],
}

const tempDirs: string[] = []

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('T-06680 interim backchannel send gate', () => {
  it('routes before the local semantic DM when the interim files opt in', async () => {
    const fixture = makeFixture('max3')
    const client = createClient()
    process.env['HRC_SESSION_REF'] = 'agent:cody:project:hrc-runtime:task:T-06680/lane:main'
    process.env['ASP_PROJECT'] = 'hrc-runtime'
    const originalWrite = process.stdout.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      await cmdDm(client.client, { json: true }, ['mable@hrc-runtime:max3', 'one copy only'])
    } finally {
      process.stdout.write = originalWrite
    }

    expect(client.requests).toHaveLength(0)
    expect(readFileSync(fixture.logPath, 'utf8')).toContain(
      'send agent:mable:project:hrc-runtime:task:max3/lane:main session agent:cody:project:hrc-runtime:task:T-06680/lane:main'
    )
    expect(readFileSync(fixture.bodyPath, 'utf8')).toBe('one copy only')
  })

  it('is inactive when the routes table is absent', async () => {
    const fixture = makeFixture('max3')
    rmSync(join(fixture.dir, 'routes.tsv'))

    const { tryRouteBackchannelDm } = await import('../backchannel-route.js')
    const result = await tryRouteBackchannelDm({
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:mable:project:hrc-runtime:task:max3/lane:main' },
      body: 'stays local',
    })

    expect(result).toBeUndefined()
    expect(() => readFileSync(fixture.logPath, 'utf8')).toThrow()
  })

  it('is bypassed during destination-side injection', async () => {
    const fixture = makeFixture('max3')
    process.env['BACKCHANNEL_BYPASS'] = '1'

    const { tryRouteBackchannelDm } = await import('../backchannel-route.js')
    const result = await tryRouteBackchannelDm({
      from: { kind: 'entity', entity: 'human' },
      to: {
        kind: 'session',
        sessionRef: 'agent:mable:project:hrc-runtime:task:max3/lane:main',
      },
      body: 'already remote',
    })

    expect(result).toBeUndefined()
    expect(() => readFileSync(fixture.logPath, 'utf8')).toThrow()
  })

  it('fails loud on a matched route and never offers local fallback', async () => {
    const fixture = makeFixture('max3', 73)
    const { tryRouteBackchannelDm } = await import('../backchannel-route.js')

    await expect(
      tryRouteBackchannelDm({
        from: { kind: 'entity', entity: 'human' },
        to: {
          kind: 'session',
          sessionRef: 'agent:mable:project:hrc-runtime:task:max3/lane:main',
        },
        body: 'do not fall back',
      })
    ).rejects.toThrow(/route=max3.*target=agent:mable.*refusing local fallback/)
    expect(readFileSync(fixture.logPath, 'utf8')).toContain('send agent:mable')
  })

  it('rejects routed dm --follow before semantic turn dispatch', async () => {
    makeFixture('svc')

    await expect(
      assertBackchannelFollowAllowed('agent:mable:project:hrc-runtime:task:minisvc/lane:main')
    ).rejects.toThrow(/--follow.*not supported.*route svc/)
  })
})

function makeFixture(
  routeNode: 'svc' | 'max3',
  sendExit = 0
): {
  dir: string
  logPath: string
  bodyPath: string
} {
  const dir = mkdtempSync(join(tmpdir(), 't06680-backchannel-'))
  tempDirs.push(dir)
  const logPath = join(dir, 'calls.log')
  const bodyPath = join(dir, 'body.txt')
  const scriptPath = join(dir, 'interim-dm-backchannel.sh')
  writeFileSync(join(dir, 'routes.tsv'), '# fixture route file\n')
  writeFileSync(join(dir, 'node'), 'fixture\n')
  writeFileSync(
    scriptPath,
    `#!/bin/sh
set -eu
case "$1" in
  route)
    printf '%s\\n' '${routeNode}'
    ;;
  send)
    printf '%s\\n' "$*" >> "$BACKCHANNEL_TEST_LOG"
    cat > '${bodyPath}'
    if [ '${sendExit}' -ne 0 ]; then
      printf 'simulated ssh failure\\n' >&2
      exit '${sendExit}'
    fi
    printf '%s\\n' '{"request":{"messageSeq":99,"messageId":"msg-routed","createdAt":"2026-07-20T00:00:00.000Z","kind":"dm","phase":"request","from":{"kind":"entity","entity":"human"},"to":{"kind":"session","sessionRef":"agent:mable:project:hrc-runtime:task:max3/lane:main"},"rootMessageId":"msg-routed","body":"one copy only","bodyFormat":"text/plain","execution":{"state":"accepted"}}}'
    ;;
esac
`
  )
  chmodSync(scriptPath, 0o755)
  process.env['BACKCHANNEL_DIR'] = dir
  process.env['BACKCHANNEL_NODE'] = 'fixture'
  process.env['BACKCHANNEL_TEST_LOG'] = logPath
  Reflect.deleteProperty(process.env, 'BACKCHANNEL_BYPASS')
  return { dir, logPath, bodyPath }
}

function createClient(): { client: HrcClient; requests: SemanticDmRequest[] } {
  const requests: SemanticDmRequest[] = []
  return {
    requests,
    client: {
      async semanticDm(request: SemanticDmRequest): Promise<SemanticDmResponse> {
        requests.push(request)
        throw new Error('local semantic DM must not be called')
      },
    } as HrcClient,
  }
}
