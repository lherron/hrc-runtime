// Real ASP compile result -> participant-owned descriptor. No process mutation.
const { neutralParticipantBrokerDescriptorHash, neutralSpecHash, neutralStartRequestHash } =
  await import(`${process.argv[2]}/node_modules/spaces-runtime-contracts/dist/index.js`)
const { joined, compiled } = await Bun.stdin.json()
const i = joined.identity
const e = compiled.plan.execution
const start = structuredClone(e.dispatchRequest.startRequest)
const spec = start.spec
if (spec.invocationId !== i.invocationId) throw Error('ASP identity drift')
const d = {
  schemaVersion: 'participant-broker-descriptor/v1',
  descriptorId: e.profile.profileId,
  descriptorHash: '',
  compatibilityHash: e.profile.compatibilityHash,
  interactionMode: 'headless',
  expectedCapabilities: {},
  brokerProtocol: e.protocol,
  brokerDriver: e.driver,
  brokerOwnership: 'participant-owned-process',
  brokerTerminal: { host: 'tmux' },
  harnessInvocation: {
    startRequest: start,
    specHash: neutralSpecHash(spec),
    startRequestHash: neutralStartRequestHash(start),
  },
  policy: {},
  observability: {
    correlation: {
      requestId: i.requestId,
      operationId: i.operationId,
      hostSessionId: joined.hostSessionId,
      generation: joined.generation,
      runtimeId: i.runtimeId,
      invocationId: i.invocationId,
    },
  },
}
spec.correlation = {
  ...spec.correlation,
  runtimeId: i.runtimeId,
  hostSessionId: joined.hostSessionId,
  generation: String(joined.generation),
  invocationId: i.invocationId,
  startRequestHash: d.harnessInvocation.startRequestHash,
  selectedProfileHash: '',
}
d.descriptorHash = neutralParticipantBrokerDescriptorHash(d)
spec.correlation.selectedProfileHash = d.descriptorHash
console.log(JSON.stringify(d))
