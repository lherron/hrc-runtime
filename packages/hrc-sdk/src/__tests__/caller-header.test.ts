/**
 * service-api rev 4 §3: every first-party request names its caller in
 * `X-Praesidium-Caller`, resolved once by the shared client:
 * explicit component name > PRAESIDIUM_CALLER > ASP_HANDLE > tty/unknown.
 * A real unix-socket server records what actually arrives on the wire.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HrcClient } from '../client.js'

let dir: string
let socketPath: string
let server: ReturnType<typeof Bun.serve>
let seen: (string | null)[]
const saved = { caller: process.env.PRAESIDIUM_CALLER, handle: process.env.ASP_HANDLE }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hrc-caller-'))
  socketPath = join(dir, 's.sock')
  seen = []
  server = Bun.serve({
    unix: socketPath,
    fetch(req) {
      seen.push(req.headers.get('x-praesidium-caller'))
      return Response.json({ ok: true })
    },
  })
  Reflect.deleteProperty(process.env, 'PRAESIDIUM_CALLER')
  Reflect.deleteProperty(process.env, 'ASP_HANDLE')
})

afterEach(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of [
    ['PRAESIDIUM_CALLER', saved.caller],
    ['ASP_HANDLE', saved.handle],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

async function send(client: HrcClient) {
  // Any route: the stub answers every path, and the header rides the transport.
  await (client as unknown as { getJson(p: string): Promise<unknown> }).getJson('/v1/probe')
  return seen.at(-1)
}

describe('X-Praesidium-Caller', () => {
  test('an explicit component name wins over the environment', async () => {
    process.env.PRAESIDIUM_CALLER = 'from-env'
    process.env.ASP_HANDLE = 'mable@x:primary'
    expect(await send(new HrcClient({ socketPath, caller: 'hrc-mail-injector' }))).toBe(
      'hrc-mail-injector'
    )
  })

  test('PRAESIDIUM_CALLER is used when no component name is given', async () => {
    process.env.PRAESIDIUM_CALLER = 'foundry-kernel:wrkq'
    process.env.ASP_HANDLE = 'mable@x:primary'
    expect(await send(new HrcClient(socketPath))).toBe('foundry-kernel:wrkq')
  })

  test('ASP_HANDLE names the seat when nothing else does', async () => {
    process.env.ASP_HANDLE = 'cody@hrc-runtime:T-12501'
    expect(await send(new HrcClient({ socketPath }))).toBe('cody@hrc-runtime:T-12501')
  })

  test('falls back to tty or unknown', async () => {
    const expected = process.stdin.isTTY ? 'tty' : 'unknown'
    expect(await send(new HrcClient(socketPath))).toBe(expected)
  })
})
