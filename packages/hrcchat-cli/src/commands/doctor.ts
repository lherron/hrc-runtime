import { HrcDomainError } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { hasFlag, printJson } from '../cli-args.js'
import { resolveTargetToSessionRef } from '../normalize.js'

type Check = {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail?: string | undefined
}

export async function cmdDoctor(client: HrcClient, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json')
  const targetInput = args[0] && !args[0].startsWith('-') ? args[0] : undefined

  const checks: Check[] = []

  // HRC connectivity
  try {
    const health = await client.getHealth()
    checks.push({ name: 'hrc-daemon', status: health.ok ? 'ok' : 'fail' })
  } catch (err) {
    checks.push({
      name: 'hrc-daemon',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  // API version
  try {
    const status = await client.getStatus()
    checks.push({
      name: 'api-version',
      status: 'ok',
      detail: `v${status.apiVersion}`,
    })

    // tmux availability
    const tmux = status.capabilities?.backend?.tmux
    if (tmux) {
      checks.push({
        name: 'tmux',
        status: tmux.available ? 'ok' : 'warn',
        detail: tmux.version ?? 'not found',
      })
    }
  } catch (err) {
    checks.push({
      name: 'api-version',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  // Target-specific diagnostics
  if (targetInput) {
    const sessionRef = resolveTargetToSessionRef(targetInput)
    try {
      const target = await client.getTarget(sessionRef)
      checks.push({
        name: 'target-lookup',
        status: 'ok',
        detail: `${target.state}`,
      })

      if (target.state === 'broken') {
        checks.push({
          name: 'target-health',
          status: 'fail',
          detail: 'target is in broken state',
        })
      }

      if (!target.capabilities.dmReady) {
        checks.push({
          name: 'dm-capability',
          status: 'warn',
          detail: `modes: ${target.capabilities.modesSupported.join(', ') || 'none'}`,
        })
      } else {
        checks.push({ name: 'dm-capability', status: 'ok' })
      }

      if (target.runtime) {
        checks.push({
          name: 'runtime',
          status: 'ok',
          detail: `${target.runtime.transport}:${target.runtime.status}`,
        })
      } else {
        checks.push({
          name: 'runtime',
          status: 'warn',
          detail: 'no bound runtime',
        })
      }
    } catch (err) {
      if (err instanceof HrcDomainError) {
        checks.push({
          name: 'target-lookup',
          status: 'fail',
          detail: `[${err.code}] ${err.message}`,
        })
      } else {
        checks.push({
          name: 'target-lookup',
          status: 'fail',
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  if (json) {
    printJson(checks)
    return
  }

  const icon = { ok: '+', warn: '~', fail: 'x' }
  for (const c of checks) {
    const suffix = c.detail ? ` (${c.detail})` : ''
    process.stdout.write(`  ${icon[c.status]} ${c.name}${suffix}\n`)
  }

  const failed = checks.some((c) => c.status === 'fail')
  if (failed) process.exit(1)
}
