import type {
  HrcAspToolchainBinaryKind,
  HrcAspToolchainHelloObservation,
  HrcAspToolchainStatus,
} from 'hrc-core'

/**
 * T-08596 (T-08569A closure) — the ASP toolchain resolver is deleted.
 *
 * The per-binary selection authority (env-override, toolchain-root, and bundled
 * binary arms), the command describer, the broker-binary mapper with its pi-sdk
 * arm, and the facade starter governed nothing after this task: every broker
 * birth launches from a frozen aspd preparation, and a birth with no frozen
 * worker launch refuses with `aspd_unconfigured` at the call site. This module
 * keeps only the shared selection types (allocation records still carry the
 * optional field, always undefined for post-closure births), the hello
 * observation registry readers, and the admin status projection, which now
 * reports the resolver as retired.
 */
export type AspToolchainBinarySource = 'env-override' | 'toolchain-root' | 'bundled'

export type AspToolchainBinarySelection = {
  kind: HrcAspToolchainBinaryKind
  name: string
  envVar: string
  source: AspToolchainBinarySource
  path: string
  configuredRoot?: string | undefined
}

export const ASP_TOOLCHAIN_BINARY_KINDS = Object.freeze([
  'aspc-facade',
  'harness-broker',
  'harness-broker-pi',
] as HrcAspToolchainBinaryKind[])

const helloObservations = new Map<
  HrcAspToolchainBinaryKind,
  { path: string; observation: HrcAspToolchainHelloObservation }
>()

export function observeAspToolchainHello(
  selection: AspToolchainBinarySelection,
  hello: Omit<HrcAspToolchainHelloObservation, 'observedAt'>
): void {
  helloObservations.set(selection.kind, {
    path: selection.path,
    observation: { ...hello, observedAt: new Date().toISOString() },
  })
}

export function externalToolchainContractDriftDetail(
  selection: AspToolchainBinarySelection
):
  | { remedy: string; toolchainSource: AspToolchainBinarySource; toolchainPath: string }
  | undefined {
  if (selection.source === 'bundled') return undefined
  return {
    remedy:
      'contract drift between resident hrc and external ASP toolchain: pull-deps + restart hrc, or align agent-spaces',
    toolchainSource: selection.source,
    toolchainPath: selection.path,
  }
}

/**
 * Admin status projection for the retired resolver: no binary is selectable,
 * so every formerly governed kind reports unavailable with the closure reason.
 * The `aspd` status section carries the live preparation endpoint instead.
 */
export function projectAspToolchainStatus(): HrcAspToolchainStatus {
  return {
    toolchainRootActive: false,
    binaries: [],
  }
}
