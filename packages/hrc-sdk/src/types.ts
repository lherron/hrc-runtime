import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'

export type ResolveSessionRequest = {
  sessionRef: string
  runtimeIntent?: HrcRuntimeIntent | undefined
}

export type ResolveSessionResponse = {
  hostSessionId: string
  generation: number
  created: boolean
  session: HrcSessionRecord
}

export type SessionFilter = {
  scopeRef?: string | undefined
  laneRef?: string | undefined
}

export type WatchOptions = {
  fromSeq?: number | undefined
  follow?: boolean | undefined
}

export type RestartStyle = 'reuse_pty' | 'fresh_pty'

export type EnsureRuntimeRequest = {
  hostSessionId: string
  intent: HrcRuntimeIntent
  restartStyle?: RestartStyle | undefined
}

export type EnsureRuntimeResponse = {
  runtimeId: string
  hostSessionId: string
  transport: 'tmux'
  status: string
  tmux: {
    sessionId: string
    windowId: string
    paneId: string
  }
}

export type CaptureResponse = {
  text: string
}

export type AttachDescriptor = {
  transport: 'tmux'
  argv: string[]
}

export type RuntimeActionResponse = {
  ok: true
  hostSessionId: string
  runtimeId: string
}
