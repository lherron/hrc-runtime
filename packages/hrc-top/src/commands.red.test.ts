import { describe, expect, it } from 'bun:test'
import type { HrcTargetView } from 'hrc-core'

import {
  type HrcTopActionExecutor,
  type HrcTopCommandModeDispatcher,
  dispatchHrcTopAction,
  dispatchHrcTopActionKey,
  executeHrcTopCommandLine,
} from './commands.js'
import type { HrcTopRow } from './read-model.js'

/*
 * T-05407 command-module contract:
 *
 * - dispatchHrcTopActionKey({ key, row, executor, confirmRunWithContinuation? })
 *   maps raw action keys to the same action dispatcher used by command mode.
 * - dispatchHrcTopAction({ action, row, executor, confirmRunWithContinuation? })
 *   executes one explicit action and returns a status/reason object for footer copy.
 * - executeHrcTopCommandLine({ line, row, executor, dispatchAction? }) parses the
 *   minimal ':' command set and delegates action commands through dispatchAction
 *   (default: dispatchHrcTopAction) so command mode cannot drift into a second path.
 * - HrcTopActionExecutor is the only side-effect seam:
 *   attachRuntime(runtimeId) obtains the SDK attach descriptor;
 *   spawnAttachDescriptor(descriptor) spawns that descriptor;
 *   runCommand(argv) shells existing hrc/hrcchat surfaces.
 *
 * These reds intentionally do not spawn a process or contact a live daemon.
 */

const capabilities: HrcTargetView['capabilities'] = {
  state: 'bound',
  modesSupported: ['headless'],
  defaultMode: 'headless',
  dmReady: true,
  sendReady: true,
  peekReady: true,
}

type ExecutorCall =
  | { type: 'attachRuntime'; runtimeId: string }
  | { type: 'spawnAttachDescriptor'; descriptor: unknown }
  | { type: 'runCommand'; argv: string[] }

function makeExecutor(calls: ExecutorCall[] = []): HrcTopActionExecutor {
  return {
    async attachRuntime(runtimeId: string) {
      calls.push({ type: 'attachRuntime', runtimeId })
      return {
        kind: 'tmux',
        runtimeId,
        command: ['tmux', 'attach-session', '-t', runtimeId],
      }
    },
    async spawnAttachDescriptor(descriptor: unknown) {
      calls.push({ type: 'spawnAttachDescriptor', descriptor })
      return { status: 'executed', reason: 'attached' }
    },
    async runCommand(argv: string[]) {
      calls.push({ type: 'runCommand', argv })
      return { status: 'executed', reason: argv.join(' ') }
    },
  }
}

function target(overrides: Partial<HrcTargetView> = {}): HrcTargetView {
  return {
    sessionRef: 'agent:cody:project:hrc-runtime:task:T-05407/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-05407',
    laneRef: 'main',
    state: 'bound',
    runtime: {
      runtimeId: 'rt-live-attachable',
      transport: 'tmux',
      status: 'ready',
      supportsLiteralSend: true,
      supportsCapture: true,
      operatorAttachable: true,
    },
    capabilities,
    ...overrides,
  }
}

function row(overrides: Partial<HrcTargetView> = {}): HrcTopRow {
  const view = target(overrides)
  return {
    id: view.runtime?.runtimeId ?? view.sessionRef,
    target: view,
    sessionRef: view.sessionRef,
    state: view.state,
    runtime: view.runtime
      ? {
          runtimeId: view.runtime.runtimeId,
          status: view.runtime.status,
        }
      : undefined,
    hasContinuation: view.continuation?.key !== undefined,
    capabilities,
    last: { source: 'unknown', at: undefined },
  }
}

function rowWithMessageContext(messageId = 'msg-123'): HrcTopRow {
  return {
    ...row(),
    message: {
      messageId,
      messageSeq: 12,
      createdAt: '2026-07-04T12:00:00.000Z',
      phase: 'queued',
      from: { kind: 'session', sessionRef: 'operator@hrc-runtime:primary' },
      to: { kind: 'session', sessionRef: 'agent:cody:project:hrc-runtime:task:T-05407/lane:main' },
      bodyPreview: 'please inspect this target',
    },
  } as HrcTopRow & { message: unknown }
}

describe('hrc-top command action dispatcher', () => {
  it('maps explicit action keys while keeping focus/inspect/tail read-only', async () => {
    const calls: ExecutorCall[] = []
    const executor = makeExecutor(calls)
    const selected = row()

    await expect(
      dispatchHrcTopActionKey({ key: '\r', row: selected, executor })
    ).resolves.toMatchObject({
      status: 'focused',
      action: 'focus',
    })
    await expect(
      dispatchHrcTopActionKey({ key: 'i', row: selected, executor })
    ).resolves.toMatchObject({
      status: 'focused',
      action: 'inspect',
    })
    await expect(
      dispatchHrcTopActionKey({ key: 'e', row: selected, executor })
    ).resolves.toMatchObject({
      status: 'focused',
      action: 'tail',
    })

    expect(calls).toEqual([])
  })

  it('runs the recommended o action through Ph2 policy', async () => {
    const calls: ExecutorCall[] = []
    const selected = row()

    const result = await dispatchHrcTopActionKey({
      key: 'o',
      row: selected,
      executor: makeExecutor(calls),
    })

    expect(result).toMatchObject({ status: 'executed', action: 'attach' })
    expect(calls.map((call) => call.type)).toEqual(['attachRuntime', 'spawnAttachDescriptor'])
  })

  it('attaches by concrete runtime id through the SDK descriptor seam, not hrc attach shell-out', async () => {
    const calls: ExecutorCall[] = []

    await expect(
      dispatchHrcTopAction({
        action: 'attach',
        row: row(),
        executor: makeExecutor(calls),
      })
    ).resolves.toMatchObject({ status: 'executed', action: 'attach' })

    expect(calls[0]).toEqual({ type: 'attachRuntime', runtimeId: 'rt-live-attachable' })
    expect(calls[1]).toMatchObject({
      type: 'spawnAttachDescriptor',
      descriptor: { runtimeId: 'rt-live-attachable' },
    })
    expect(calls).not.toContainEqual({
      type: 'runCommand',
      argv: ['hrc', 'attach', 'rt-live-attachable'],
    })
  })

  it('surfaces resume without continuation as a disabled action and never falls back to run', async () => {
    const calls: ExecutorCall[] = []
    const dormantWithoutContinuation = row({
      state: 'dormant',
      runtime: undefined,
      continuation: undefined,
    })

    const result = await dispatchHrcTopAction({
      action: 'resume',
      row: dormantWithoutContinuation,
      executor: makeExecutor(calls),
    })

    expect(result).toMatchObject({
      status: 'disabled',
      action: 'resume',
      errorCode: 'missing_valid_continuation',
    })
    expect(result.reason).toContain('continuation')
    expect(calls).toEqual([])
  })

  it('requires confirmation before R starts a target that already has a continuation', async () => {
    const calls: ExecutorCall[] = []
    const selected = row({
      state: 'dormant',
      runtime: undefined,
      continuation: { provider: 'openai', key: 'conv-existing' },
    })

    const gated = await dispatchHrcTopActionKey({
      key: 'R',
      row: selected,
      executor: makeExecutor(calls),
    })

    expect(gated).toMatchObject({ status: 'confirmation_required', action: 'run' })
    expect(gated.reason).toContain('continuation')
    expect(calls).toEqual([])

    await dispatchHrcTopActionKey({
      key: 'R',
      row: selected,
      executor: makeExecutor(calls),
      confirmRunWithContinuation: true,
    })

    expect(calls).toEqual([
      { type: 'runCommand', argv: ['hrc', 'run', 'cody@hrc-runtime:T-05407'] },
    ])
  })

  it('returns footer-copy reasons for disabled explicit actions instead of throwing', async () => {
    const result = await dispatchHrcTopAction({
      action: 'attach',
      row: row({
        runtime: {
          runtimeId: 'rt-headless',
          transport: 'headless',
          status: 'ready',
          supportsLiteralSend: false,
          supportsCapture: true,
          operatorAttachable: false,
        },
      }),
      executor: makeExecutor(),
    })

    expect(result).toMatchObject({ status: 'disabled', action: 'attach' })
    expect(result.reason).toContain('operator-attachable')
  })

  it('uses existing hrcchat surfaces for message show/reply and keeps preview read-only', async () => {
    const calls: ExecutorCall[] = []
    const executor = makeExecutor(calls)
    const selected = row()

    await expect(
      dispatchHrcTopAction({
        action: 'messagePreview',
        row: selected,
        messageId: 'msg-123',
        executor,
      })
    ).resolves.toMatchObject({ status: 'focused', action: 'messagePreview' })
    expect(calls).toEqual([])

    await dispatchHrcTopAction({
      action: 'messageShow',
      row: selected,
      messageId: 'msg-123',
      executor,
    })
    await dispatchHrcTopAction({
      action: 'messageReply',
      row: selected,
      messageId: 'msg-123',
      executor,
    })

    expect(calls).toEqual([
      { type: 'runCommand', argv: ['hrcchat', 'show', 'msg-123'] },
      {
        type: 'runCommand',
        argv: ['hrcchat', 'dm', 'cody@hrc-runtime:T-05407', '--reply-to', 'msg-123', '-'],
      },
    ])
  })

  it('uses selected row message context for preview/show/reply and disables message actions without it', async () => {
    const calls: ExecutorCall[] = []
    const executor = makeExecutor(calls)
    const selected = rowWithMessageContext('msg-from-row')
    const noMessage = row()

    // T-05462 red bar: message actions are eligible only from concrete
    // selected-row message context, not from unbounded history or hints.
    await expect(
      dispatchHrcTopActionKey({ key: 'p', row: selected, executor })
    ).resolves.toMatchObject({
      status: 'focused',
      action: 'messagePreview',
    })
    expect(calls).toEqual([])

    await dispatchHrcTopActionKey({ key: 's', row: selected, executor })
    await dispatchHrcTopActionKey({ key: 'y', row: selected, executor })

    expect(calls).toEqual([
      { type: 'runCommand', argv: ['hrcchat', 'show', 'msg-from-row'] },
      {
        type: 'runCommand',
        argv: ['hrcchat', 'dm', 'cody@hrc-runtime:T-05407', '--reply-to', 'msg-from-row', '-'],
      },
    ])

    await expect(
      dispatchHrcTopActionKey({ key: 'p', row: noMessage, executor })
    ).resolves.toMatchObject({
      status: 'disabled',
      action: 'messagePreview',
    })
    await expect(
      dispatchHrcTopActionKey({ key: 's', row: noMessage, executor })
    ).resolves.toMatchObject({
      status: 'disabled',
      action: 'messageShow',
    })
    await expect(
      dispatchHrcTopActionKey({ key: 'y', row: noMessage, executor })
    ).resolves.toMatchObject({
      status: 'disabled',
      action: 'messageReply',
    })
    expect(calls).toHaveLength(2)
  })
})

describe('hrc-top minimal command mode', () => {
  it.each([
    [':attach', 'attach'],
    [':resume', 'resume'],
    [':run', 'run'],
    [':tail', 'tail'],
    [':capture', 'capture'],
    [':inspect', 'inspect'],
    [':message-preview', 'messagePreview'],
    [':message-show', 'messageShow'],
    [':message-reply', 'messageReply'],
  ] as const)('delegates %s to the same action dispatcher', async (line, action) => {
    const delegated: string[] = []
    const dispatchAction: HrcTopCommandModeDispatcher = async (input) => {
      delegated.push(input.action)
      return { status: 'delegated', action: input.action, reason: 'delegated' }
    }

    await expect(
      executeHrcTopCommandLine({
        line,
        row: row(),
        executor: makeExecutor(),
        dispatchAction,
      })
    ).resolves.toMatchObject({ status: 'delegated', action })

    expect(delegated).toEqual([action])
  })

  it('handles filter, clear-filter, and quit as command-mode state changes without mutating executor calls', async () => {
    const calls: ExecutorCall[] = []
    const executor = makeExecutor(calls)

    await expect(
      executeHrcTopCommandLine({ line: ':filter hrc-runtime cody', row: row(), executor })
    ).resolves.toMatchObject({ status: 'filter_changed', filterText: 'hrc-runtime cody' })

    await expect(
      executeHrcTopCommandLine({ line: ':clear-filter', row: row(), executor })
    ).resolves.toMatchObject({ status: 'filter_changed', filterText: '' })

    await expect(
      executeHrcTopCommandLine({ line: ':quit', row: row(), executor })
    ).resolves.toMatchObject({ status: 'quit' })

    expect(calls).toEqual([])
  })

  it.each([':terminate', ':drop-continuation', ':clear-context', ':sweep', ':forced-restart'])(
    'does not wire destructive command %s',
    async (line) => {
      const calls: ExecutorCall[] = []

      await expect(
        executeHrcTopCommandLine({ line, row: row(), executor: makeExecutor(calls) })
      ).resolves.toMatchObject({ status: 'disabled' })

      expect(calls).toEqual([])
    }
  )
})
