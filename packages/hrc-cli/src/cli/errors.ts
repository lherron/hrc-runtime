import { type HrcDomainError, HrcErrorCode } from 'hrc-core'

import { printJson } from '../print.js'
import { CliStatusExit } from './shared.js'

export function isHrcDomainErrorLike(
  err: unknown
): err is Pick<HrcDomainError, 'code' | 'message' | 'detail'> {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string' &&
    'message' in err &&
    typeof err.message === 'string'
  )
}

export function printHrcDomainErrorBody(err: unknown): boolean {
  if (!isHrcDomainErrorLike(err)) {
    return false
  }

  throw new Error(
    JSON.stringify({
      error: {
        code: err.code,
        message: err.message,
        detail: err.detail ?? {},
      },
    })
  )
}

/**
 * Emit a structured JSON error envelope for the scope commands (run/start/attach)
 * when `--json` is requested. Preserves the full HrcDomainError `detail` payload —
 * including the broker rejection `code` and ASP `diagnostics[]` — that the human
 * renderer summarizes. Writes the JSON to stdout and exits non-zero via
 * CliStatusExit so the top-level handler does not re-prefix the line with `hrc:`.
 */
export function emitScopeCommandErrorJson(
  command: 'attach' | 'run' | 'start' | 'resume',
  err: unknown,
  scopeInput: string,
  sessionRef?: string
): never {
  const base = isHrcDomainErrorLike(err)
    ? { code: err.code, message: err.message, detail: err.detail ?? {} }
    : {
        code: 'internal',
        message: err instanceof Error ? err.message : String(err),
        detail: {} as Record<string, unknown>,
      }
  printJson({
    error: {
      ...base,
      command,
      scope: scopeInput,
      ...(sessionRef ? { sessionRef } : {}),
    },
  })
  throw new CliStatusExit(1)
}

/**
 * Convert common failure modes from `hrc run` into actionable error messages.
 * Preserves the original message for unrecognized cases. Returns an Error with
 * the wrapped message so the top-level `fatal()` handler prints it with the
 * `hrc:` prefix.
 */
export function explainScopeCommandError(
  command: 'attach' | 'run' | 'start' | 'resume',
  err: unknown,
  scopeInput: string,
  sessionRef?: string
): Error {
  const raw = err instanceof Error ? err.message : String(err)

  // Daemon not running — discoverSocket throws this
  if (raw.includes('HRC daemon socket not found')) {
    return new Error(`${raw}\n  Start it with: hrc server start --daemon`)
  }

  // Bun fetch connection-refused when socket exists but nothing is listening
  if (/typo in the url or port|ECONNREFUSED|Unable to connect/i.test(raw)) {
    return new Error(
      'cannot reach HRC daemon (socket present but not responding).\n' +
        '  The daemon may have crashed. Try: hrc server restart'
    )
  }

  if (isHrcDomainErrorLike(err)) {
    const detail = (err.detail ?? {}) as { scopeRef?: string; sessionRef?: string }
    const storedScope = detail.scopeRef

    // Hydration guard: server rejected a stored non-canonical scopeRef
    if (
      err.code === HrcErrorCode.INVALID_SELECTOR &&
      raw.includes('canonical agent ScopeRef') &&
      storedScope &&
      !storedScope.startsWith('agent:')
    ) {
      return new Error(
        `cannot reattach to "${scopeInput}": an existing session is stored with a legacy scopeRef "${storedScope}".\n  This database predates the canonical scope cleanup (T-01077).\n  Fix: wipe HRC state.\n    rm ~/.local/state/hrc/state.sqlite*`
      )
    }

    // Generic invalid sessionRef (user-facing input problem)
    if (err.code === HrcErrorCode.INVALID_SELECTOR) {
      return new Error(
        `invalid sessionRef for "${scopeInput}": ${err.message}\n` +
          `  sessionRef sent: ${sessionRef ?? '(not yet computed)'}`
      )
    }

    if (err.code === HrcErrorCode.STALE_CONTEXT) {
      return new Error(`conflict on "${scopeInput}": ${err.message}`)
    }

    if (err.code === HrcErrorCode.UNSUPPORTED_CAPABILITY) {
      return new Error(`cannot ${command} "${scopeInput}": ${err.message}`)
    }

    // Broker compile/admission rejection. The HrcDomainError `detail` carries the
    // specific rejection `code`, the ASP compiler `diagnostics[]`, and routing
    // context (route/flag/runId) — all of which the bare one-line fallback below
    // would discard. Expand them so operators see *why* admission failed without
    // having to grep the daemon logs.
    if (err.code === HrcErrorCode.RUNTIME_UNAVAILABLE) {
      const detail = (err.detail ?? {}) as {
        code?: string
        message?: string
        route?: string
        flag?: string
        runId?: string
        diagnostics?: Array<{
          level?: string
          code?: string
          message?: string
          profileId?: string
        }>
      }
      const lines = [`cannot ${command} "${scopeInput}": ${err.message}`]
      if (detail.code) {
        lines.push(`  reason: ${detail.code}`)
      }
      // The broker-start path (e.g. `broker_start_failed`) carries its actual
      // root cause in `detail.message` (e.g. "Failed to connect to broker unix
      // socket") rather than the admission-shape `detail.diagnostics[]`. Surface
      // it when present and distinct from the top-line message — otherwise the
      // operator only sees the generic reason code and has to grep daemon logs.
      if (detail.message && detail.message !== err.message) {
        lines.push(`  cause: ${detail.message}`)
      }
      if (detail.route) {
        lines.push(`  route: ${detail.route}${detail.flag ? ` (flag ${detail.flag})` : ''}`)
      }
      for (const diag of detail.diagnostics ?? []) {
        const where = diag.profileId ? ` [${diag.profileId}]` : ''
        const code = diag.code ? ` ${diag.code}` : ''
        lines.push(
          `  • ${diag.level ?? 'error'}${where}${code}: ${diag.message ?? ''}`.replace(/\s+$/, '')
        )
      }
      if (detail.runId) {
        lines.push(`  runId: ${detail.runId}  (grep hrc-server logs for full diagnostics)`)
      }
      return new Error(lines.join('\n'))
    }

    // Other domain errors — show the code so operators can look it up
    return new Error(`"${scopeInput}" [${err.code}]: ${err.message}`)
  }

  // Fallback: pass the raw message through. Top-level fatal() adds the `hrc:`
  // prefix, and most helper errors already mention the scope in-line.
  return err instanceof Error ? err : new Error(raw)
}
