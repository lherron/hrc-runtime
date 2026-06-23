import {
  HrcClient,
  buildHrcRuntimeIntent,
  discoverSocket,
} from '../../../../../packages/hrc-sdk/src/index.ts'

const client = new HrcClient(await discoverSocket())
const task = `broker-session-open-smoke-${Date.now()}`
const sessionRef = `agent:cody:project:hrc-runtime:task:${task}/lane:main`
const intent = buildHrcRuntimeIntent({
  agentId: 'cody',
  agentRoot: '/Users/lherron/praesidium/var/agents/cody',
  projectRoot: '/Users/lherron/praesidium/hrc-runtime',
  cwd: '/Users/lherron/praesidium/hrc-runtime',
  runMode: 'task',
  interactive: false,
  preferredMode: 'nonInteractive',
})

const resolved = await client.resolveSession({
  sessionRef,
  runtimeIntent: intent,
  create: true,
})
if (!resolved.found) throw new Error('session did not resolve/create')

let opened: Awaited<ReturnType<HrcClient['openBrokerSession']>> | undefined
try {
  opened = await client.openBrokerSession({
    hostSessionId: resolved.hostSessionId,
    runtimeIntent: intent,
  })

  if (opened.transport !== 'headless') {
    throw new Error(`unexpected transport ${opened.transport}`)
  }
  if (opened.startIdentity.kind !== 'broker') {
    throw new Error(`unexpected startIdentity ${opened.startIdentity.kind}`)
  }
  if (!opened.startIdentity.invocationId) {
    throw new Error('missing invocationId')
  }
  if ('runId' in opened.observation.broker.selector) {
    throw new Error('open cursor must not contain runId')
  }

  const runs = await client.listRuns({ hostSessionId: opened.hostSessionId })
  if (runs.length !== 0) {
    const runIds = runs.map((run) => run.runId).join(',')
    throw new Error(`open allocated turn runs: ${runIds}`)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        hostSessionId: opened.hostSessionId,
        runtimeId: opened.runtimeId,
        status: opened.status,
        invocationId: opened.startIdentity.invocationId,
        afterSeq: opened.observation.broker.afterSeq,
        selectorKeys: Object.keys(opened.observation.broker.selector).sort(),
        supportsInputQueue: opened.supportsInputQueue,
        runCount: runs.length,
      },
      null,
      2
    )
  )
} finally {
  if (opened?.runtimeId) {
    await client
      .terminate(opened.runtimeId, {
        reason: 'broker-session-open-smoke-cleanup',
        source: 'manual-e2e-smoke',
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`cleanup terminate failed: ${message}`)
      })
  }
}
