import { HrcDomainError } from 'hrc-core'

import { printJson } from '../print.js'
import { isHrcDomainErrorLike } from './errors.js'
import { resolveManagedScopeContext } from './scope.js'
import { CliStatusExit, createClient } from './shared.js'

/**
 * T-10850 — `hrc restart <scope> [--force]`: end the scope's conversation and
 * relaunch it fresh (generation + 1, continuation dropped). The semantic form
 * of `/quit` + `hrc start` for a seat whose context has gone cold in the
 * provider's prompt cache. A busy or unobservable seat is refused unless
 * --force; nothing changes on a refusal.
 */
export async function cmdRestart(target: string, opts: { force: boolean; json: boolean }) {
  const scope = await resolveManagedScopeContext(target)
  const client = createClient()
  const status = await client.getStatus()
  if (status.capabilities?.sessionRestart !== true) {
    throw new Error(
      `the running HRC daemon predates hrc restart; ask mable@${scope.projectId ?? '<project>'}:primary to restart it`
    )
  }
  const resolved = await client.resolveSession({ sessionRef: scope.sessionRef })
  if (!resolved.found) {
    throw new Error(`no session exists for "${target}". Start one with: hrc start ${target}`)
  }

  let result: Awaited<ReturnType<typeof client.restartSession>>
  try {
    result = await client.restartSession({
      hostSessionId: resolved.hostSessionId,
      expectedGeneration: resolved.generation,
      ...(opts.force ? { force: true } : {}),
    })
  } catch (err) {
    if (!isHrcDomainErrorLike(err)) throw err
    if (opts.json) {
      printJson({ ok: false, code: err.code, message: err.message, detail: err.detail ?? {} })
      throw new CliStatusExit(1)
    }
    const hint =
      err.code === 'runtime_busy' || err.code === 'seat_unobservable'
        ? `\n  interrupt the turn first, or override with: hrc restart ${target} --force`
        : ''
    throw new HrcDomainError(err.code, `restart refused: ${err.message}${hint}`, err.detail ?? {})
  }

  if (opts.json) {
    printJson({ ok: result.launch.status === 'started', ...result })
  } else {
    process.stdout.write(
      `${target}: generation ${result.generation - 1} → ${result.generation} (${result.hostSessionId})\n`
    )
    if (result.launch.status === 'started') {
      process.stdout.write(`  launched ${result.launch.runtimeId}\n`)
    } else {
      process.stdout.write(
        `  launch failed: ${result.launch.message}\n  recover with: hrc start ${target}\n`
      )
    }
  }
  if (result.launch.status !== 'started') throw new CliStatusExit(1)
}
