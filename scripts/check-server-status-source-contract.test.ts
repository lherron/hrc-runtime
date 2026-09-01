import { describe, expect, it } from 'bun:test'
import ts from 'typescript'

import {
  ACTIVATION_CONTRACT,
  SERVER_STATUS_CONTRACT,
  findServerStatusParityViolations,
} from '../packages/hrc-cli/src/cli-runtime/server-status-contract.js'
import {
  type ServerRuntimeStatus,
  formatServerRuntimeStatus,
} from '../packages/hrc-cli/src/cli-runtime/server-status.js'
import {
  SERVER_STATUS_SOURCE_CONTRACT_EXEMPTIONS,
  findServerStatusSourceContractViolations,
} from './check-server-status-source-contract.js'

const FORMATTER_PATH = `${import.meta.dir}/../packages/hrc-cli/src/cli-runtime/server-status.ts`
const formatterSource = await Bun.file(FORMATTER_PATH).text()

function compileFormatter(source: string): typeof formatServerRuntimeStatus {
  const sourceFile = ts.createSourceFile('server-status.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'formatServerRuntimeStatus'
  )
  if (!declaration) throw new Error('formatServerRuntimeStatus declaration not found')

  const functionSource = declaration.getText(sourceFile).replace(/^export\s+/, '')
  const javascript = ts.transpileModule(functionSource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return Function(
    `${javascript}; return formatServerRuntimeStatus`
  )() as typeof formatServerRuntimeStatus
}

const coincidentPidStatus = {
  ok: true,
  status: 'healthy',
  exitCode: 0,
  running: true,
  runtimeRoot: '/run',
  stateRoot: '/state',
  pid: 4242,
  pidAlive: true,
  pidPath: '/run/pid',
  daemon: {
    running: true,
    pid: 4242,
    pidAlive: true,
    pidPath: '/run/pid',
    pidFileExists: true,
  },
  socketPath: '/run/socket',
  socketResponsive: true,
  socket: { path: '/run/socket', responsive: true },
  lockPath: '/run/lock',
  lockExists: true,
  tmuxSocketPath: '/run/tmux',
  apiHealth: { ok: true },
  tmux: {
    available: true,
    socketPath: '/run/tmux',
    running: false,
    sessionCount: 0,
    sessions: [],
  },
} satisfies ServerRuntimeStatus

describe('server-status source-derived contract guard (T-07652)', () => {
  it('matches every declared label path to the real formatter accessor', () => {
    expect(
      findServerStatusSourceContractViolations(formatterSource, SERVER_STATUS_CONTRACT)
    ).toEqual([])
  })

  it('rejects an accessor mutation even when coincident values fool the value checker', () => {
    const originalAccessor = "status.pid ?? '(none)'"
    const mutantAccessor = "status.daemon.pid ?? '(none)'"
    expect(formatterSource.split(originalAccessor)).toHaveLength(2)
    const mutantSource = formatterSource.replace(originalAccessor, mutantAccessor)
    const mutantFormatter = compileFormatter(mutantSource)

    expect(coincidentPidStatus.pid).toBe(coincidentPidStatus.daemon.pid)
    expect(mutantFormatter(coincidentPidStatus)).toBe(
      formatServerRuntimeStatus(coincidentPidStatus)
    )
    expect(
      findServerStatusParityViolations(coincidentPidStatus, mutantFormatter(coincidentPidStatus))
    ).toEqual([])

    expect(
      findServerStatusSourceContractViolations(mutantSource, SERVER_STATUS_CONTRACT)
    ).toContainEqual({
      label: 'pid',
      declaredPaths: ['pid'],
      sourcePaths: ['daemon.pid'],
    })
  })

  it('keeps render metadata and the activation-only path explicitly hand-authored', () => {
    expect(SERVER_STATUS_SOURCE_CONTRACT_EXEMPTIONS).toEqual({
      entryFields: ['multiline', 'summarized', 'optional'],
      activationOnlyPaths: ['release.processStartedAt'],
    })
    const renderedPaths = new Set(SERVER_STATUS_CONTRACT.flatMap((entry) => entry.paths))
    expect(
      ACTIVATION_CONTRACT.map((entry) => entry.path).filter((path) => !renderedPaths.has(path))
    ).toEqual([...SERVER_STATUS_SOURCE_CONTRACT_EXEMPTIONS.activationOnlyPaths])
  })
})
