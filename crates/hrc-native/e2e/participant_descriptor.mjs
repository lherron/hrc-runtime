const { neutralParticipantBrokerDescriptorHash, neutralSpecHash, neutralStartRequestHash } =
  await import(`${process.argv[2]}/node_modules/spaces-runtime-contracts/dist/index.js`)
const raw = await Bun.stdin.json()
if (process.argv[4] === 'rehash') {
  raw.descriptorHash = neutralParticipantBrokerDescriptorHash(raw)
  raw.harnessInvocation.startRequest.spec.correlation.selectedProfileHash = raw.descriptorHash
  console.log(JSON.stringify(raw))
  process.exit(0)
}
const { identity: i, hostSessionId, generation } = raw
const spec = {
  specVersion: 'harness-broker.invocation/v1',
  invocationId: i.invocationId,
  labels: { participant: 'n1-scratch-descriptor-admission' },
  harness: { frontend: 'external', provider: 'external', driver: 'n1-external-driver' },
  process: {
    command: 'n1-external-driver',
    args: [],
    cwd: process.argv[3],
    lockedEnv: {},
    harnessTransport: { kind: 'pipes' },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
  driver: { kind: 'n1-external-driver' },
  correlation: {
    runtimeId: i.runtimeId,
    hostSessionId,
    generation: String(generation),
    invocationId: i.invocationId,
    startRequestHash: '',
    selectedProfileHash: '',
  },
}
const d = {
  schemaVersion: 'participant-broker-descriptor/v1',
  descriptorId: 'n1-participant-descriptor',
  descriptorHash: '',
  compatibilityHash: 'n1-participant-descriptor-compatibility',
  interactionMode: 'headless',
  expectedCapabilities: {},
  brokerProtocol: 'harness-broker/0.2',
  brokerDriver: 'n1-external-driver',
  brokerOwnership: 'participant-owned-process',
  harnessInvocation: { startRequest: { spec }, specHash: '', startRequestHash: '' },
  policy: {
    permissionPolicy: { mode: 'deny', audit: true },
    inputPolicy: {
      readyInput: 'start-turn',
      busy: { whenBusy: 'queue', maxDepth: 1 },
      supportedKinds: ['user'],
      attachmentPolicy: { localImages: false, fileRefs: false },
    },
    exposurePolicy: { mode: 'none' },
  },
  observability: {
    correlation: {
      requestId: i.requestId,
      operationId: i.operationId,
      hostSessionId,
      generation,
      runtimeId: i.runtimeId,
      invocationId: i.invocationId,
    },
  },
}
d.harnessInvocation.specHash = neutralSpecHash(spec)
d.harnessInvocation.startRequestHash = neutralStartRequestHash(d.harnessInvocation.startRequest)
spec.correlation.startRequestHash = d.harnessInvocation.startRequestHash
d.descriptorHash = neutralParticipantBrokerDescriptorHash(d)
spec.correlation.selectedProfileHash = d.descriptorHash
console.log(JSON.stringify(d))
