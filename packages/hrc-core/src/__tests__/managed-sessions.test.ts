import { describe, expect, test } from 'bun:test'

import { HrcErrorCode, httpStatusForErrorCode } from '../errors.js'
import type {
  ApplyAppManagedSessionsRequest,
  EnsureAppSessionRequest,
  HrcAppCommandSessionSpec,
  HrcAppHarnessSessionSpec,
  HrcAppSessionRef,
  HrcCommandLaunchSpec,
  HrcManagedSessionKind,
  HrcManagedSessionRecord,
  ListAppSessionsRequest,
  RemoveAppSessionRequest,
} from '../index.js'

describe('managed app session contracts', () => {
  test('exports stable app-owned selector and managed session kinds', () => {
    const selector: HrcAppSessionRef = {
      appId: 'workbench',
      appSessionKey: 'primary',
    }
    const harnessKind: HrcManagedSessionKind = 'harness'
    const commandKind: HrcManagedSessionKind = 'command'

    expect(selector.appId).toBe('workbench')
    expect(selector.appSessionKey).toBe('primary')
    expect(harnessKind).toBe('harness')
    expect(commandKind).toBe('command')
  })

  test('exports command launch specs with shell and exec-compatible fields', () => {
    const spec: HrcCommandLaunchSpec = {
      launchMode: 'shell',
      argv: ['bun', 'run', 'dev'],
      cwd: '/tmp/workbench',
      env: { FOO: 'bar' },
      unsetEnv: ['OLD_ENV'],
      pathPrepend: ['/custom/bin'],
      shell: {
        executable: '/bin/zsh',
        login: true,
        interactive: true,
      },
    }

    expect(spec.launchMode).toBe('shell')
    expect(spec.argv).toEqual(['bun', 'run', 'dev'])
    expect(spec.shell?.executable).toBe('/bin/zsh')
  })

  test('exports managed session records without leaking synthetic SessionRef identifiers', () => {
    const session: HrcManagedSessionRecord = {
      appId: 'workbench',
      appSessionKey: 'primary',
      kind: 'harness',
      label: 'Primary',
      metadata: { color: 'blue' },
      activeHostSessionId: 'hsid-001',
      generation: 2,
      status: 'active',
      createdAt: '2026-04-03T12:00:00.000Z',
      updatedAt: '2026-04-03T12:05:00.000Z',
    }

    expect(session.activeHostSessionId).toBe('hsid-001')
    expect(session.generation).toBe(2)
    expect(session.status).toBe('active')
    expect('sessionRef' in session).toBe(false)
  })
})

describe('managed app session HTTP DTOs', () => {
  test('exports ensure request DTOs for harness and command sessions', () => {
    const harnessSpec: HrcAppHarnessSessionSpec = {
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: {
          provider: 'openai',
          interactive: true,
        },
      },
    }
    const commandSpec: HrcAppCommandSessionSpec = {
      kind: 'command',
      command: {
        launchMode: 'exec',
        argv: ['tail', '-f', 'server.log'],
      },
    }

    const harnessRequest: EnsureAppSessionRequest = {
      selector: { appId: 'workbench', appSessionKey: 'assistant' },
      spec: harnessSpec,
      restartStyle: 'fresh_pty',
    }
    const commandRequest: EnsureAppSessionRequest = {
      selector: { appId: 'workbench', appSessionKey: 'logs' },
      spec: commandSpec,
      forceRestart: true,
    }

    expect(harnessRequest.spec.kind).toBe('harness')
    expect(commandRequest.spec.kind).toBe('command')
  })

  test('exports list/remove/apply request DTOs keyed by app-owned selectors', () => {
    const listRequest: ListAppSessionsRequest = {
      appId: 'workbench',
      kind: 'command',
      includeRemoved: true,
    }
    const removeRequest: RemoveAppSessionRequest = {
      selector: { appId: 'workbench', appSessionKey: 'logs' },
      terminateRuntime: false,
    }
    const applyRequest: ApplyAppManagedSessionsRequest = {
      appId: 'workbench',
      pruneMissing: true,
      sessions: [
        {
          appSessionKey: 'assistant',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: {
                provider: 'anthropic',
                interactive: true,
              },
            },
          },
        },
        {
          appSessionKey: 'logs',
          spec: {
            kind: 'command',
            command: {
              launchMode: 'exec',
              argv: ['tail', '-f', 'server.log'],
            },
          },
        },
      ],
    }

    expect(listRequest.kind).toBe('command')
    expect(removeRequest.selector.appSessionKey).toBe('logs')
    expect(applyRequest.sessions.map((session) => session.spec.kind)).toEqual([
      'harness',
      'command',
    ])
  })

  test('does not require a hostSessionId in apply payloads for managed app sessions', () => {
    const request: ApplyAppManagedSessionsRequest = {
      appId: 'workbench',
      sessions: [
        {
          appSessionKey: 'assistant',
          spec: {
            kind: 'harness',
            runtimeIntent: {
              placement: 'workspace',
              harness: {
                provider: 'openai',
                interactive: true,
              },
            },
          },
        },
      ],
    }

    expect('hostSessionId' in request).toBe(false)
    expect(request.sessions).toHaveLength(1)
  })
})

describe('managed app session error codes', () => {
  test('defines platform registry error codes with stable string values', () => {
    expect(HrcErrorCode.UNKNOWN_APP_SESSION).toBe('unknown_app_session')
    expect(HrcErrorCode.APP_SESSION_REMOVED).toBe('app_session_removed')
    expect(HrcErrorCode.SESSION_KIND_MISMATCH).toBe('session_kind_mismatch')
    expect(HrcErrorCode.UNSUPPORTED_CAPABILITY).toBe('unsupported_capability')
    expect(HrcErrorCode.MISSING_SESSION_SPEC).toBe('missing_session_spec')
  })

  test('maps managed-session registry errors to 404, 409, and 422 statuses', () => {
    expect(httpStatusForErrorCode(HrcErrorCode.UNKNOWN_APP_SESSION)).toBe(404)
    expect(httpStatusForErrorCode(HrcErrorCode.APP_SESSION_REMOVED)).toBe(409)
    expect(httpStatusForErrorCode(HrcErrorCode.SESSION_KIND_MISMATCH)).toBe(422)
    expect(httpStatusForErrorCode(HrcErrorCode.UNSUPPORTED_CAPABILITY)).toBe(422)
    expect(httpStatusForErrorCode(HrcErrorCode.MISSING_SESSION_SPEC)).toBe(422)
  })
})
