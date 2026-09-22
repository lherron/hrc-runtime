import {
  type ParticipantBrokerDescriptor,
  neutralParticipantBrokerDescriptorHash,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

export function makeParticipantBrokerDescriptor(input: {
  requestId: string
  operationId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  invocationId: string
  cwd: string
  driver?: string
  interactionMode?: 'headless' | 'interactive' | 'nonInteractive'
  brokerTerminal?: ParticipantBrokerDescriptor['brokerTerminal']
}): ParticipantBrokerDescriptor {
  const driver = input.driver ?? 'noop-driver'
  const interactionMode = input.interactionMode ?? 'headless'
  const descriptor = {
    schemaVersion: 'participant-broker-descriptor/v1',
    descriptorId: `descriptor-${input.invocationId}`,
    descriptorHash: '',
    compatibilityHash: `compatibility-${input.runtimeId}`,
    interactionMode,
    expectedCapabilities: {},
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: driver,
    brokerOwnership: 'participant-owned-process',
    ...(input.brokerTerminal === undefined ? {} : { brokerTerminal: input.brokerTerminal }),
    harnessInvocation: {
      startRequest: {
        spec: {
          specVersion: 'harness-broker.invocation/v1',
          invocationId: input.invocationId,
          labels: { participant: 'test-fixture' },
          harness: { frontend: 'test', provider: 'test', driver },
          process: {
            command: driver,
            args: [],
            cwd: input.cwd,
            lockedEnv: {},
            harnessTransport: { kind: 'pipes' },
          },
          interaction: {
            mode: interactionMode,
            turnConcurrency: 'single',
            inputQueue: 'none',
          },
          driver: { kind: driver },
          correlation: {
            runtimeId: input.runtimeId,
            hostSessionId: input.hostSessionId,
            generation: String(input.generation),
            invocationId: input.invocationId,
            startRequestHash: '',
            selectedProfileHash: '',
          },
        },
      },
      specHash: '',
      startRequestHash: '',
    },
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
        requestId: input.requestId,
        operationId: input.operationId,
        hostSessionId: input.hostSessionId,
        generation: input.generation,
        runtimeId: input.runtimeId,
        invocationId: input.invocationId,
      },
    },
  } as unknown as ParticipantBrokerDescriptor
  const startRequest = descriptor.harnessInvocation.startRequest
  descriptor.harnessInvocation.specHash = neutralSpecHash(startRequest.spec)
  descriptor.harnessInvocation.startRequestHash = neutralStartRequestHash(startRequest)
  startRequest.spec.correlation.startRequestHash = descriptor.harnessInvocation.startRequestHash
  descriptor.descriptorHash = neutralParticipantBrokerDescriptorHash(descriptor)
  startRequest.spec.correlation.selectedProfileHash = descriptor.descriptorHash
  return descriptor
}
