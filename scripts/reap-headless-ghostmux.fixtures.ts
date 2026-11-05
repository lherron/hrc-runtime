import type { PaneStatus } from './reap-headless-ghostmux'

// Shared reap-test status: an idle, complete broker-tmux runtime with no active
// run, which isQuitEligible accepts. Tests override single fields per guard.
export function eligibleStatus(overrides: Partial<PaneStatus> = {}): PaneStatus {
  return {
    id: 'PANE0001',
    title: 'hrc headless agent:clod:project:hrc-runtime:task:reap-probe',
    agent: 'clod',
    identity: {
      kind: 'project-task',
      agentId: 'clod',
      projectId: 'hrc-runtime',
      taskId: 'reap-probe',
    },
    scopeRef: 'agent:clod:project:hrc-runtime:task:reap-probe',
    runtimeId: 'rt-eligible',
    runtimeStatus: 'ready',
    transport: 'tmux',
    controllerKind: 'harness-broker',
    activeRunId: '',
    turnStatus: 'completed',
    runId: 'run-done',
    lastActivityUtc: '2026-06-14T15:50:38.000Z',
    lastActivityLocal: '2026-06-14 10:50:38',
    latestTurnEventKind: 'turn.completed',
    ...overrides,
  }
}
