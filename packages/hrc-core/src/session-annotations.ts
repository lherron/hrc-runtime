/**
 * Seat annotations (seat-annotations r1.1 §3–4): namespaced, kinded opaque JSON
 * objects on a seat (continuity) or one of its generations. rusthrc owns
 * storage and admission; these are the wire shapes of its four routes.
 */
import type { SessionMetadataTarget } from './session-metadata.js'

export type SessionAnnotationSubject = 'seat' | 'generation'

/** One annotation's key. `generation` is required for subject `generation`. */
export type SessionAnnotationKey = SessionMetadataTarget & {
  subject: SessionAnnotationSubject
  generation?: number | undefined
  ns: string
  kind: string
  id: string
}

/**
 * Optional fences, checked in the write transaction. `updatedAt: null` means
 * the annotation must not exist yet.
 */
export type SessionAnnotationExpect = {
  generation?: number | undefined
  attentionAt?: string | undefined
  updatedAt?: string | null | undefined
}

export type SessionAnnotation = {
  scopeRef: string
  laneRef: string
  subject: SessionAnnotationSubject
  /** `''` for subject `seat`. */
  hostSessionId: string
  generation: number | null
  ns: string
  kind: string
  id: string
  body: Record<string, unknown>
  /** The `expect` that admitted the last put, or null. */
  fence: SessionAnnotationExpect | null
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export type ListSessionAnnotationsRequest = SessionMetadataTarget & {
  subject?: SessionAnnotationSubject | undefined
  generation?: number | undefined
  ns?: string | undefined
  kind?: string | undefined
}
export type ListSessionAnnotationsResponse = { annotations: SessionAnnotation[] }

export type PutSessionAnnotationRequest = SessionAnnotationKey & {
  body: Record<string, unknown>
  expect?: SessionAnnotationExpect | undefined
}
export type PutSessionAnnotationResponse = { annotation: SessionAnnotation; created: boolean }

export type DeleteSessionAnnotationRequest = SessionAnnotationKey & {
  expect?: SessionAnnotationExpect | undefined
}
export type DeleteSessionAnnotationResponse = { deleted: boolean }

export type ActOnSessionAnnotationRequest = SessionAnnotationKey & {
  action: string
  attributes?: Record<string, unknown> | undefined
}
export type ActOnSessionAnnotationResponse = { hrcSeq: number }

/** Writer attribution: sent as `x-hrc-principal-ref`, recorded as `updatedBy`. */
export type SessionAnnotationWriteOptions = { principalRef?: string | undefined }

/** Refusal codes the annotation routes answer with (`error.code`). */
export type SessionAnnotationRefusalCode =
  | 'annotation_invalid'
  | 'unknown_generation'
  | 'unknown_host_session'
  | 'annotation_quota'
  | 'stale_generation'
  | 'stale_attention'
  | 'stale_annotation'
  | 'unknown_annotation'
