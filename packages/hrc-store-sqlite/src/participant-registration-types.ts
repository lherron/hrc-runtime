/** Durable state names from T-08344 rev6 C.7. */
export type ParticipantAttemptState =
  | 'REGISTERED'
  | 'IDENTITY_MINTED'
  | 'PREPARED'
  | 'HOSTING_INTENT_PERSISTED'
  | 'REALIZED'
  | 'DISPATCH_FROZEN'
  | 'INSTALL_CONFIRMED'
  | 'INVOCATION_READY'
  | 'ATTACH_CONFIRMED'
  | 'ACTIVE'
  | 'DETACHED'
  | 'SUPERSEDED'
  | 'ABANDONED'
  | 'TERMINAL'

export type ParticipantRecoveryDisposition = 'unresolved' | 'reconciled' | 'abandoned'
export type ParticipantEstablishmentWorkState = 'pending' | 'retry_wait' | 'exhausted' | 'completed'
export type ParticipantActivationClassification =
  | 'attached'
  | 'replacement'
  | 'resume'
  | 'attached_unknown'

/**
 * C.7 is a graph, not a rank. In particular, a detached participant returns
 * through current attach confirmation; it does not mint a new user resume.
 */
const participantAttemptTransitions: Readonly<
  Record<ParticipantAttemptState, readonly ParticipantAttemptState[]>
> = {
  REGISTERED: ['IDENTITY_MINTED'],
  IDENTITY_MINTED: ['PREPARED', 'ABANDONED'],
  PREPARED: ['HOSTING_INTENT_PERSISTED', 'ABANDONED'],
  HOSTING_INTENT_PERSISTED: ['REALIZED', 'ABANDONED'],
  REALIZED: ['DISPATCH_FROZEN', 'ABANDONED'],
  DISPATCH_FROZEN: ['INSTALL_CONFIRMED', 'ABANDONED'],
  INSTALL_CONFIRMED: ['INVOCATION_READY', 'ABANDONED'],
  INVOCATION_READY: ['ATTACH_CONFIRMED', 'ABANDONED', 'TERMINAL'],
  ATTACH_CONFIRMED: ['ABANDONED', 'TERMINAL'],
  ACTIVE: ['DETACHED', 'ABANDONED', 'TERMINAL'],
  DETACHED: ['ATTACH_CONFIRMED', 'ABANDONED', 'TERMINAL'],
  SUPERSEDED: [],
  ABANDONED: [],
  TERMINAL: [],
}

export function allowsParticipantAttemptTransition(
  from: ParticipantAttemptState,
  to: ParticipantAttemptState,
  dispositionReason: string | undefined
): boolean {
  if (!participantAttemptTransitions[from].includes(to)) return false
  if (to === 'ABANDONED' || to === 'TERMINAL') return dispositionReason !== undefined
  return true
}

export type ParticipantAddressPolicy = 'permanent-keyed' | 'selected-scope'
export type ParticipantContinuityPolicy = 'key-scoped' | 'host-incarnation'
export type ParticipantLifecycleOwner = 'hrc-managed' | 'externally-owned'
export type ParticipantReplaySemantics = 'none' | 'full-source-replay'

/**
 * The resolved policy a direct join answers for itself.
 *
 * R7.1 stores it on the registration so a direct lookup never needs a class or
 * a class to say what an address is.
 */
export type ParticipantRegistrationPolicy = {
  addressPolicy: ParticipantAddressPolicy
  continuityPolicy: ParticipantContinuityPolicy
  lifecycleOwner: ParticipantLifecycleOwner
  replaySemantics: ParticipantReplaySemantics
}

export type ParticipantRegistration = {
  registrationId: string
  /**
   * Every optional field below is optional because a direct join may genuinely
   * have no value for it. R7.1 forbids a fabricated adapter, an empty
   * workspace or a pretend preparation, so absent stays absent through the
   * repository, the API and post-join preparation.
   */
  classId?: string | undefined
  join: 'hrc-hosted' | 'participant-served'
  participantKey?: string | undefined
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  workspaceCwd?: string | undefined
  /** Participant-owned broker endpoint; absent for HRC-hosted participants. */
  socketPath?: string | undefined
  /** Resolved policy for this direct registration. */
  policy?: ParticipantRegistrationPolicy | undefined
  /**
   * The participant's declared current host identity. HRC records the
   * declaration; it never certifies it, parses a PID out of it, or asks
   * another component to vouch for it (R6.1).
   */
  hostIncarnationId?: string | undefined
  createdAt: string
  updatedAt: string
}

/** R7.3: why HRC's continuation selection came out the way it did. */
export type ParticipantContinuationReason =
  | 'carried'
  | 'no_continuation'
  | 'continuation_invalidated'
  | 'reuse_disabled'

/**
 * R7.3: what the driver was asked for and what it said, never a claim that
 * native model context was actually restored.
 */
export type ParticipantResumeState = 'not_requested' | 'requested' | 'unsupported' | 'indeterminate'

export type ParticipantContinuationSelection = {
  carried: boolean
  reason: ParticipantContinuationReason
  /** The HRC continuation object carried into this attempt, when one was. */
  selectedJson?: string | undefined
}

export type ParticipantAttempt = {
  attemptId: string
  registrationId: string
  attachEpoch: number
  requestId: string
  operationId: string
  invocationId: string
  runtimeId: string
  /**
   * The host binding this attempt serves. NULL for a legacy key-scoped
   * attempt, which therefore owns its runtime exclusively; attempts that share
   * a runtime must share this binding (R6.5, enforced by trigger).
   */
  hostBindingId?: string | undefined
  state: ParticipantAttemptState
  /** The first validated final participant descriptor, before any spawn. */
  preparedDescriptorJson?: string | undefined
  adapterDispatchEnvJson?: string | undefined
  /** HRC-owned executable, paths, token reference, and requested presentation. */
  hostingIntentJson?: string | undefined
  /** Actual leases read after realization or validated rediscovery. */
  realizedHostingJson?: string | undefined
  /** Full immutable dispatch tuple, frozen before the first ensure call. */
  dispatchJson?: string | undefined
  /** Immutable broker acknowledgement after INSTALL -> HELLO succeeds. */
  brokerIdentityJson?: string | undefined
  /** Classification frozen when this attempt identity is allocated. */
  activationClassification?: ParticipantActivationClassification | undefined
  /** Exact validated producer receipt for the prior writer. */
  writerEvidenceJson?: string | undefined
  /** Marks the one initial activation whose classification may release replay. */
  initialActivationConfirmedAt?: string | undefined
  /** Independent C.8 disposition for recovery of this attempt by a successor. */
  recoveryDisposition: ParticipantRecoveryDisposition
  recoveryReason?: string | undefined
  /** Durable, restart-discoverable establishment delivery state. */
  establishmentWorkState: ParticipantEstablishmentWorkState
  establishmentAttemptCount: number
  establishmentNextAttemptAt?: string | undefined
  establishmentLastError?: string | undefined
  /** The participant-served broker endpoint this exact attempt attached on. */
  attachSocketPath?: string | undefined
  /** HRC's own continuation decision, frozen with this attempt's identity. */
  continuation?: ParticipantContinuationSelection | undefined
  resumeState?: ParticipantResumeState | undefined
  resumeReason?: string | undefined
  /** Durable replacement request carried on the existing attempt row. */
  replacementIntentJson?: string | undefined
  dispositionReason?: string | undefined
  createdAt: string
  updatedAt: string
}
