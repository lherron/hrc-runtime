import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')
const TASK_ID = 'T-07654'
const TASK_SCOPE = `rex@agent-spaces:${TASK_ID}`
const RESOLVED_TASK_SCOPE = `agent:rex:project:agent-spaces:task:${TASK_ID}`
const RESOLVED_PRIMARY_SCOPE = 'agent:rex:project:agent-spaces:task:primary'

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type StubMode = 'accepted' | 'admission-rejected'

describe('hrc start detached prompt acknowledgement [RED]', () => {
  let root: string
  let runtimeRoot: string
  let stateRoot: string
  let agentsRoot: string
  let projectRoot: string
  let stub: ReturnType<typeof Bun.serve> | undefined
  let stubMode: StubMode
  let turnRequests: Array<Record<string, unknown>>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hrc-start-detached-ack-'))
    runtimeRoot = join(root, 'runtime')
    stateRoot = join(root, 'state')
    agentsRoot = join(root, 'agents')
    projectRoot = join(root, 'agent-spaces')
    stubMode = 'accepted'
    turnRequests = []

    await mkdir(runtimeRoot, { recursive: true })
    await mkdir(stateRoot, { recursive: true })
    await mkdir(join(agentsRoot, 'rex'), { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(agentsRoot, 'rex', 'agent-profile.toml'), 'schemaVersion = 2\n')
    await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\n')

    stub = Bun.serve({
      unix: join(runtimeRoot, 'hrc.sock'),
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/v1/sessions/resolve') {
          return Response.json({
            found: true,
            hostSessionId: 'hs-start-ack',
            generation: 1,
            created: true,
            session: {},
          })
        }
        if (path === '/v1/turns') {
          const turnRequest = (await request.json()) as Record<string, unknown>
          turnRequests.push(turnRequest)
          if (stubMode === 'admission-rejected') {
            return Response.json(
              {
                error: {
                  code: 'runtime_unavailable',
                  message: 'broker compile/admission rejected',
                  detail: { reason: 'fixture rejection' },
                },
              },
              { status: 503 }
            )
          }
          const waitFor = turnRequest['waitFor']
          const stage =
            waitFor === 'terminal'
              ? 'terminal'
              : waitFor === 'turn_started'
                ? 'turn_started'
                : 'accepted'
          const status =
            stage === 'terminal' ? 'completed' : stage === 'turn_started' ? 'started' : 'accepted'
          return Response.json(
            {
              runId: 'run-still-running',
              hostSessionId: 'hs-start-ack',
              generation: 1,
              runtimeId: 'rt-still-running',
              transport: 'headless',
              stage,
              status,
              ...(stage === 'terminal' ? { outcome: 'completed' } : {}),
              replayed: false,
              supportsInFlightInput: true,
              startIdentity: { kind: 'broker', invocationId: 'inv-started' },
              observation: {
                lifecycle: {
                  selector: {
                    runId: 'run-still-running',
                    runtimeId: 'rt-still-running',
                    generation: 1,
                  },
                },
              },
            },
            { status: stage === 'accepted' ? 202 : 200 }
          )
        }
        return Response.json({ error: { message: `unexpected ${path}` } }, { status: 404 })
      },
    })
  })

  afterEach(async () => {
    stub?.stop(true)
    stub = undefined
    await rm(root, { recursive: true, force: true })
  })

  async function runStart(scope: string, extraArgs: string[] = []): Promise<CliResult> {
    const cleanEnv = { ...process.env }
    for (const key of [
      'AGENT_SCOPE_REF',
      'AGENT_SESSION_REF',
      'AGENT_TASK',
      'ASP_DEFAULT_TASK',
      'ASP_HANDLE',
      'ASP_SCOPE_REF',
      'ASP_TASK_ID',
      'HRC_SESSION_REF',
    ]) {
      delete cleanEnv[key]
    }
    const proc = Bun.spawn(
      ['bun', 'run', CLI_PATH, 'start', scope, '-p', 'keep working', ...extraArgs],
      {
        cwd: projectRoot,
        env: {
          ...cleanEnv,
          HRC_RUNTIME_DIR: runtimeRoot,
          HRC_STATE_DIR: stateRoot,
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  }

  it('accepts bare --wait and --wait=completed as blocking-to-completion modes', async () => {
    const bare = await runStart(TASK_SCOPE, ['--wait'])
    const explicit = await runStart(TASK_SCOPE, ['--wait=completed'])

    expect(bare.exitCode).toBe(0)
    expect(explicit.exitCode).toBe(0)
    expect(turnRequests.map((request) => request['waitFor'])).toEqual(['terminal', 'terminal'])
    expect(turnRequests.map((request) => request['waitForCompletion'])).toEqual([true, true])
    expect(JSON.parse(bare.stdout).runtime).toMatchObject({
      stage: 'terminal',
      outcome: 'completed',
    })
  })

  it('maps --wait=started to the persisted turn-started boundary', async () => {
    const result = await runStart(TASK_SCOPE, ['--wait=started'])

    expect(result.exitCode).toBe(0)
    expect(turnRequests[0]).toMatchObject({
      waitFor: 'turn_started',
      waitForCompletion: false,
    })
    expect(JSON.parse(result.stdout).runtime).toMatchObject({
      stage: 'turn_started',
      status: 'started',
    })
    expect(result.stderr).toContain('turn started — follow with:')
  })

  it('exits zero for an accepted turn and nonzero for admission rejection', async () => {
    const accepted = await runStart(TASK_SCOPE)
    stubMode = 'admission-rejected'
    const rejected = await runStart(TASK_SCOPE)

    expect(accepted.exitCode).toBe(0)
    expect(JSON.parse(accepted.stdout).runtime).toMatchObject({
      stage: 'accepted',
      status: 'accepted',
    })
    expect(turnRequests[0]?.['idempotencyKey']).toMatch(/^hrc-start-/)
    expect(rejected.exitCode).not.toBe(0)
    expect(rejected.stderr).toContain('broker compile/admission rejected')
  })

  it('prints task-aware supervision commands to stderr in human mode', async () => {
    const result = await runStart(TASK_SCOPE)
    const body = JSON.parse(result.stdout) as Record<string, unknown>

    expect(result.exitCode).toBe(0)
    expect(body['follow']).toBeUndefined()
    expect(result.stderr).toContain('accepted detached — follow with:')
    expect(result.stderr).toContain(`hrc monitor watch ${TASK_ID} --follow`)
    expect(result.stderr).toContain(`wrkq monitor wait ${TASK_ID} --until all-terminal`)
  })

  it('prints only a runnable HRC scope selector when the resolved scope has no task id', async () => {
    const result = await runStart('rex@agent-spaces')
    const expected = `hrc monitor watch scope:${RESOLVED_PRIMARY_SCOPE} --follow`

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(expected)
    expect(result.stderr).not.toContain('wrkq monitor wait')
    expect(result.stderr).not.toMatch(/hrc monitor watch T-[0-9]+/)
  })

  it('puts structured follow commands in JSON mode and keeps stderr empty', async () => {
    const result = await runStart(TASK_SCOPE, ['--json'])
    const body = JSON.parse(result.stdout) as {
      sessionRef: string
      follow?: Array<{ purpose: string; cmd: string }>
    }

    expect(result.exitCode).toBe(0)
    expect(body.sessionRef).toBe(`${RESOLVED_TASK_SCOPE}/lane:main`)
    expect(body.follow).toEqual([
      {
        purpose: 'live room feed (milestone cadence)',
        cmd: `hrc monitor watch ${TASK_ID} --follow`,
      },
      {
        purpose: 'block until the task lands',
        cmd: `wrkq monitor wait ${TASK_ID} --until all-terminal`,
      },
    ])
    expect(result.stderr).toBe('')
  })
})
