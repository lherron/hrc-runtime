import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI_BIN = join(import.meta.dir, '..', '..', 'bin', 'hrc.js')
const SCOPE = 'agent:arris:project:arris:task:reg-t07139-cli'

type CliResult = { stdout: string; stderr: string; exitCode: number }

describe('T-07139 real hrc admin registrations gc parse path', () => {
  let root: string
  let runtimeRoot: string
  let server: ReturnType<typeof Bun.serve>
  const posts: unknown[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hrc-cli-t07139-'))
    runtimeRoot = join(root, 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    posts.length = 0
    server = Bun.serve({
      unix: join(runtimeRoot, 'hrc.sock'),
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== '/v1/admin/registrations/gc') {
          return Response.json({ error: 'unexpected_path' }, { status: 404 })
        }
        if (request.method === 'GET') {
          return Response.json({
            generatedAt: '2026-08-09T20:01:00.000Z',
            lingerMs: 1_000,
            candidates: [
              {
                registrationId: 'registration-t07139-cli',
                classId: 'arris-agent',
                scopeRef: SCOPE,
                hostSessionId: 'hsid-t07139-cli',
                runtimeId: 'rt-t07139-cli',
                runtimeStatus: 'terminated',
                terminalReason: 'external_participant_exit',
                terminalAt: '2026-08-09T20:00:00.000Z',
                eligibleAt: '2026-08-09T20:00:01.000Z',
              },
            ],
          })
        }
        if (request.method === 'POST') {
          posts.push(await request.json())
          return Response.json({
            results: [
              {
                scopeRef: SCOPE,
                registrationId: 'registration-t07139-cli',
                status: 'retired',
              },
            ],
            summary: { requested: 1, retired: 1, idempotent: 0, skipped: 0, errors: 0 },
          })
        }
        return Response.json({ error: 'unexpected_method' }, { status: 405 })
      },
    })
  })

  afterEach(async () => {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  })

  async function run(args: string[]): Promise<CliResult> {
    const proc = Bun.spawn([process.execPath, CLI_BIN, ...args], {
      env: {
        ...process.env,
        HRC_RUNTIME_DIR: runtimeRoot,
        HRC_SESSION_REF: undefined,
        HRC_RUN_ID: undefined,
        ASP_SCOPE_REF: undefined,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  }

  test('bin -> Commander registry -> argv bridge -> list handler is reachable', async () => {
    const result = await run(['admin', 'registrations', 'gc', '--json'])
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({
      candidates: [{ scopeRef: SCOPE }],
    })
    expect(posts).toEqual([])
  })

  test('explicit --yes invocation dispatches the exact selected scope', async () => {
    const result = await run(['admin', 'registrations', 'gc', SCOPE, '--yes', '--json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      results: [{ scopeRef: SCOPE, status: 'retired' }],
    })
    expect(posts).toEqual([{ scopeRefs: [SCOPE] }])
  })

  test('piped/non-TTY mutation refuses before POST unless --yes is explicit', async () => {
    const result = await run(['admin', 'registrations', 'gc', SCOPE, '--json'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('confirmation requires a TTY')
    expect(result.stderr).toContain('--yes')
    expect(posts).toEqual([])
  })
})
