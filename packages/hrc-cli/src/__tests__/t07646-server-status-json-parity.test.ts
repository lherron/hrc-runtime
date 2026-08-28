import { describe, expect, it } from 'bun:test'

import {
  ACTIVATION_CONTRACT,
  SERVER_STATUS_CONTRACT,
  findServerStatusParityViolations,
  renderServerStatusJsonContract,
  resolveContractPath,
} from '../cli-runtime/server-status-contract.js'
import { formatServerRuntimeStatus } from '../cli-runtime/server-status.js'
import type { ServerRuntimeStatus } from '../cli-runtime/server-status.js'

/**
 * T-07646. Activation is scripted against `hrc server status --json`, and four
 * separate paths were reported as serializing `null`. None of them did: they
 * were never the paths. jq answers `null` for an absent key, so a wrong path is
 * indistinguishable from a dead field.
 *
 * These tests render both projections from ONE status object and hold them to
 * each other, so the failure mode that remains — a human line whose JSON name is
 * undocumented, or a documented path the JSON has dropped — cannot land quietly.
 *
 * The fixtures are typed against the real wire contracts (`HrcReleaseStatus`,
 * `HrcStatusResponse['node']`), so a rename upstream breaks compilation here
 * rather than silently agreeing with a stale hand-written shape.
 */

const federatedAtomicStatus: ServerRuntimeStatus = {
  ok: true,
  status: 'healthy',
  exitCode: 0,
  running: true,
  runtimeRoot: '/var/run/hrc',
  stateRoot: '/var/state/hrc',
  cwd: '/Users/lherron/praesidium',
  binaryPath: '/releases/release-20260827235853180-97049/packages/hrc-cli/src/cli.ts',
  packagePath: '/releases/release-20260827235853180-97049/packages/hrc-server',
  release: {
    mode: 'atomic',
    releaseId: 'release-20260827235853180-97049',
    releasePath: '/releases/release-20260827235853180-97049',
    manifestPath: '/releases/release-20260827235853180-97049/praesidium-release.json',
    hrcBuild: {
      schema: 1,
      repository: 'hrc-runtime',
      canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
      sourceCommit: '0b46eefe0c51827b42b6589b637916c195c1ab02',
      setName: 'hrc',
      setVersion: '0.1.0-dev.20260827185905',
      builtAt: '2026-08-27T23:59:04.660Z',
    },
    aspBuild: {
      schema: 1,
      repository: 'agent-spaces',
      canonicalRemote: 'git@gh-agent-spaces:lherron/agent-spaces.git',
      sourceCommit: '1e3231ec8d3ccc38c50b9f61fb8deeacc8ef60d4',
      setName: 'asp',
      setVersion: '0.1.1-dev.20260825223449',
      builtAt: '2026-08-26T03:34:49.375Z',
    },
    installedAt: '2026-08-27T23:59:13.795Z',
    processStartedAt: '2026-08-28T00:01:36.622Z',
    runningEqualsInstalled: true,
  },
  pid: 99582,
  pidAlive: true,
  pidPath: '/var/run/hrc/server.pid',
  daemon: {
    running: true,
    pid: 99582,
    pidAlive: true,
    pidPath: '/var/run/hrc/server.pid',
    pidFileExists: true,
  },
  socketPath: '/var/run/hrc/hrc.sock',
  socketResponsive: true,
  socket: { path: '/var/run/hrc/hrc.sock', responsive: true },
  lockPath: '/var/run/hrc/server.lock',
  lockExists: true,
  tmuxSocketPath: '/var/run/hrc/tmux.sock',
  apiHealth: { ok: true },
  api: {
    startedAt: '2026-08-28T00:01:36.622Z',
    uptime: 2758,
    apiVersion: '0.1.0',
    runtimeRoot: '/var/run/hrc',
    stateRoot: '/var/state/hrc',
    socketPath: '/var/run/hrc/hrc.sock',
    dbPath: '/var/state/hrc/state.sqlite',
    cwd: '/Users/lherron/praesidium',
    binaryPath: '/releases/release-20260827235853180-97049/packages/hrc-cli/src/cli.ts',
    packagePath: '/releases/release-20260827235853180-97049/packages/hrc-server',
    release: {
      mode: 'unmanaged',
      packagePath: '/releases/release-20260827235853180-97049/packages/hrc-server',
      processStartedAt: '2026-08-28T00:01:36.622Z',
      runningEqualsInstalled: false,
    },
  },
  node: {
    nodeId: 'max3',
    nodeIdProvenance: 'declared',
    mode: 'federated',
    configPath: '/var/state/hrc/federation.json',
    configExists: true,
    peerCount: 2,
    peers: [
      {
        nodeId: 'svc',
        endpoint: 'http://100.117.215.92:18493/',
        registryEndpoint: 'http://100.117.215.92:18491/',
      },
      { nodeId: 'lab', endpoint: 'http://100.117.215.92:18492/' },
    ],
  },
  peerHealth: [
    {
      nodeId: 'svc',
      state: 'healthy',
      checkedAt: '2026-08-28T00:47:34.521Z',
      answeredAt: '2026-08-28T00:47:34.523Z',
      latencyMs: 2,
    },
    {
      nodeId: 'lab',
      state: 'unreachable',
      checkedAt: '2026-08-28T00:47:34.521Z',
      latencyMs: 5000,
      detail: 'connect ECONNREFUSED',
    },
  ],
  tmux: {
    available: true,
    socketPath: '/var/run/hrc/tmux.sock',
    running: false,
    sessionCount: 0,
    sessions: [],
  },
  serverStatus: { startedAt: '2026-08-28T00:01:36.622Z', apiVersion: '0.1.0' },
}

const probeFailedStatus: ServerRuntimeStatus = {
  ok: false,
  status: 'probe-failed',
  exitCode: 3,
  running: false,
  runtimeRoot: '',
  stateRoot: '',
  pidAlive: false,
  pidPath: '',
  daemon: { running: false, pidAlive: false, pidPath: '', pidFileExists: false },
  socketPath: '',
  socketResponsive: false,
  socket: { path: '', responsive: false },
  lockPath: '',
  lockExists: false,
  tmuxSocketPath: '',
  apiHealth: { ok: false, error: 'status diagnostic failed' },
  tmux: {
    available: false,
    socketPath: '',
    running: false,
    sessionCount: 0,
    sessions: [],
    error: 'status diagnostic failed',
  },
  error: 'ENOTDIR: runtime root is not a directory',
}

const unmanagedStatus: ServerRuntimeStatus = {
  ...federatedAtomicStatus,
  release: {
    mode: 'unmanaged',
    packagePath: '/Users/lherron/praesidium/hrc-runtime/packages/hrc-server',
    processStartedAt: '2026-08-28T00:01:36.622Z',
    runningEqualsInstalled: false,
  },
  node: {
    nodeId: 'hrcdev',
    nodeIdProvenance: 'derived',
    mode: 'single-node',
    configPath: '/var/state/hrc/federation.json',
    configExists: false,
    peerCount: 0,
    peers: [],
  },
  peerHealth: [],
  tmux: {
    available: true,
    socketPath: '/var/run/hrc/tmux.sock',
    running: true,
    sessionCount: 3,
    sessions: ['a', 'b', 'c'],
  },
}

const cases: Array<[string, ServerRuntimeStatus]> = [
  ['a federated node on an atomic release', federatedAtomicStatus],
  ['a single-node daemon on an unmanaged checkout', unmanagedStatus],
  ['a failed local probe', probeFailedStatus],
]

describe('hrc server status --json / human parity (T-07646)', () => {
  for (const [name, status] of cases) {
    it(`renders both projections of ${name} from one status object with no drift`, () => {
      const violations = findServerStatusParityViolations(status, formatServerRuntimeStatus(status))
      expect(violations.map((violation) => violation.detail)).toEqual([])
    })
  }

  it('names a human line whose JSON path is undocumented', () => {
    const rendered = `${formatServerRuntimeStatus(federatedAtomicStatus)}  smuggled:    yes\n`
    const violations = findServerStatusParityViolations(federatedAtomicStatus, rendered)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('undocumented-line')
    expect(violations[0]?.label).toBe('smuggled')
  })

  it('names a documented path the JSON document no longer carries', () => {
    const { node: _dropped, ...withoutNode } = federatedAtomicStatus
    const violations = findServerStatusParityViolations(
      withoutNode as ServerRuntimeStatus,
      formatServerRuntimeStatus(federatedAtomicStatus)
    )
    expect(violations.some((violation) => violation.path === 'node.nodeId')).toBe(true)
    expect(violations.every((violation) => violation.kind === 'unresolved-path')).toBe(true)
  })

  it('names a path whose JSON value disagrees with the value the human line shows', () => {
    const divergent: ServerRuntimeStatus = {
      ...federatedAtomicStatus,
      node: { ...federatedAtomicStatus.node!, nodeId: 'not-the-rendered-node' },
    }
    const violations = findServerStatusParityViolations(
      divergent,
      formatServerRuntimeStatus(federatedAtomicStatus)
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'value-not-rendered', path: 'node.nodeId' })
    )
  })

  it('treats a key holding undefined as absent, the way JSON.stringify does', () => {
    const withUndefinedCwd = {
      ...federatedAtomicStatus,
      cwd: undefined,
    } as unknown as ServerRuntimeStatus
    const violations = findServerStatusParityViolations(
      withUndefinedCwd,
      formatServerRuntimeStatus(federatedAtomicStatus)
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'unresolved-path', path: 'cwd' })
    )
  })
})

describe('the activation contract published by hrc info (T-07646)', () => {
  it('documents only paths the contract table actually names', () => {
    const known = new Set(SERVER_STATUS_CONTRACT.flatMap((entry) => entry.paths))
    // release.processStartedAt is carried by the JSON but summarized by the
    // human "release:" line, so it is documented without being a rendered path.
    const rendered = ACTIVATION_CONTRACT.map((entry) => entry.path).filter(
      (path) => path !== 'release.processStartedAt'
    )
    for (const path of rendered) expect(known).toContain(path)
  })

  it('resolves every documented path against a real status document', () => {
    for (const entry of ACTIVATION_CONTRACT) {
      const values = resolveContractPath(
        JSON.parse(JSON.stringify(federatedAtomicStatus)),
        entry.path
      )
      expect({ path: entry.path, resolved: values.length }).toEqual({
        path: entry.path,
        resolved: 1,
      })
    }
  })

  it('prints the wrong path beside each right one, since jq cannot tell them apart', () => {
    const text = renderServerStatusJsonContract()
    expect(text).toContain('release.hrcBuild.sourceCommit')
    expect(text).toContain('(NOT .sourceCommit)')
    expect(text).toContain('node.nodeId')
    expect(text).toContain('(NOT .nodeId)')
    expect(text).toContain('(NOT .release.id)')
    expect(text).toContain('(NOT .hrcBuild.version)')
    expect(text).toContain('(NOT .processStartedAt)')
  })

  it('carries every path the reported activation failures reached for', () => {
    const documented = new Set(ACTIVATION_CONTRACT.map((entry) => entry.path))
    for (const path of [
      'node.nodeId',
      'release.releaseId',
      'release.hrcBuild.sourceCommit',
      'release.hrcBuild.setVersion',
      'release.processStartedAt',
      'release.runningEqualsInstalled',
    ]) {
      expect(documented).toContain(path)
    }
  })
})
