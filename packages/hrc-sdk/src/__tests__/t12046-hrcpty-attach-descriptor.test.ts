/**
 * T-12046: the SDK decodes rusthrc's hrcpty operator surfaces.
 *
 * The fixture is a real capture from crates/hrc-native/e2e/hrcpty_substrate.py
 * (step 8, attached door on a live hrcpty seat): GET /v1/attach and the seat's
 * GET /v1/presentation/runtimes row. Failure modes: the descriptor narrows to
 * tmux only, the fence loses supervisorPid, or the row's hrcpty block is
 * dropped or reshaped on decode.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcPresentationRuntimeRow, HrcptyOperatorAttachDescriptor } from 'hrc-core'

import { type AttachDescriptor, HrcClient } from '../index'
import captured from './fixtures/t12046-hrcpty-attach.json'

describe('hrcpty attach surfaces (T-12046)', () => {
  let tmpDir: string
  let server: ReturnType<typeof Bun.serve> | undefined
  let client: HrcClient

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-hrcpty-'))
    const unix = join(tmpDir, 'hrc.sock')
    server = Bun.serve({
      unix,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/v1/attach') return Response.json(captured.attach)
        if (url.pathname === '/v1/presentation/runtimes') {
          return Response.json({ ok: true, runtimes: [captured.presentationRow] })
        }
        return new Response('not found', { status: 404 })
      },
    })
    client = new HrcClient(unix)
  })

  afterEach(async () => {
    server?.stop(true)
    server = undefined
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('decodes GET /v1/attach for an hrcpty seat as the hrcpty descriptor', async () => {
    const descriptor: AttachDescriptor = await client.getAttachDescriptor(
      captured.attach.bindingFence.runtimeId
    )
    expect(descriptor.transport).toBe('hrcpty')
    if (descriptor.transport !== 'hrcpty') throw new Error('not narrowed')
    const hrcpty: HrcptyOperatorAttachDescriptor = descriptor
    expect(Object.keys(hrcpty).sort()).toEqual(['argv', 'bindingFence', 'transport'])
    expect(hrcpty.argv[0]?.endsWith('/hrc-pty')).toBe(true)
    expect(hrcpty.argv.slice(1, 3)).toEqual(['attach', '--socket'])
    expect(hrcpty.argv).toHaveLength(4)
    expect(Object.keys(hrcpty.bindingFence).sort()).toEqual([
      'generation',
      'hostSessionId',
      'runtimeId',
      'supervisorPid',
    ])
    expect(typeof hrcpty.bindingFence.supervisorPid).toBe('number')
    expect(typeof hrcpty.bindingFence.generation).toBe('number')
  })

  it('keeps the presentation row hrcpty block on decode', async () => {
    const { runtimes } = await client.listPresentationRuntimes()
    const row: HrcPresentationRuntimeRow | undefined = runtimes[0]
    expect(row?.presentation?.operatorAttachable).toBe(true)
    expect(row?.tmux).toBeUndefined()
    const hrcpty = row?.hrcpty
    expect(hrcpty && Object.keys(hrcpty).sort()).toEqual([
      'attachCommand',
      'socketPath',
      'supervisorPid',
    ])
    expect(hrcpty?.supervisorPid).toBe(captured.attach.bindingFence.supervisorPid)
    expect(hrcpty?.attachCommand).toBe(
      `${captured.attach.argv[0]} attach --socket ${hrcpty?.socketPath}`
    )
    expect(captured.attach.argv[3]).toBe(hrcpty?.socketPath)
  })
})
