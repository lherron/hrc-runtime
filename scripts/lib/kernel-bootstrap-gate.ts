import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Pre-flip gate (T-12019): boot the candidate release's hrc-kernel on a
 * scratch socket against this node's live ledger and require it to catch up
 * with seats. c54531bb shipped a kernel whose projection was schema-refused,
 * and the install flipped current anyway; Loggia then served zero seats.
 *
 * The kernel is read-side: ingest_only, durability none, and the ledger is
 * opened SQLITE_OPEN_READ_ONLY (hrc-store `open_readonly`), so the gate
 * writes nothing to the ledger. Its owner API points at a socket inside the
 * scratch root that nothing serves, so it cannot reach the live daemon.
 */
export type KernelGateReport = { seats: number; caughtUpMs: number }

const READY_TIMEOUT_MS = 30_000

export async function gateKernelBootstrap(
  kernel: string,
  ledgerPath: string
): Promise<KernelGateReport> {
  if (!existsSync(ledgerPath)) {
    throw new Error(`hrc-kernel bootstrap gate: no HRC ledger at ${ledgerPath}`)
  }
  // SUN_LEN: macOS caps a socket path at 104 bytes, and TMPDIR is long.
  const root = await mkdtemp('/tmp/hrc-kgate-')
  const child = spawn(
    kernel,
    ['--runtime-root', root, '--ledger-path', ledgerPath, '--hrc-socket', join(root, 'hrc.sock')],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  try {
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ready line within ${READY_TIMEOUT_MS / 1000} s`)),
        READY_TIMEOUT_MS
      )
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
        const newline = stdout.indexOf('\n')
        if (newline >= 0) {
          clearTimeout(timer)
          resolve(stdout.slice(0, newline))
        }
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`exited before ready (${signal ?? `status ${code}`})`))
      })
    })
    let ready: Record<string, unknown>
    try {
      ready = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error(`unparseable ready line: ${line}`)
    }
    const seats = typeof ready['seats'] === 'number' ? ready['seats'] : 0
    if (ready['status'] !== 'serving' || ready['bootstrapping'] !== false || seats <= 0) {
      const why =
        ready['bootstrapping'] !== false
          ? 'did not catch up'
          : `caught up with ${seats} seats (a node with no seats fails the gate)`
      throw new Error(`${why}; kernel error: ${String(ready['error'] ?? 'none reported')}`)
    }
    return { seats, caughtUpMs: Number(ready['caughtUpMs']) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `hrc-kernel bootstrap gate FAILED for ${kernel} against ${ledgerPath}: ${message}${
        stderr.trim() === '' ? '' : `\nkernel stderr:\n${stderr.trim()}`
      }`
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
      await exited
      clearTimeout(timer)
    }
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  // bun scripts/lib/kernel-bootstrap-gate.ts <hrc-kernel> <ledger-path>
  const [kernel, ledgerPath] = process.argv.slice(2)
  if (kernel === undefined || ledgerPath === undefined) {
    console.error('usage: kernel-bootstrap-gate.ts <hrc-kernel> <ledger-path>')
    process.exit(2)
  }
  gateKernelBootstrap(kernel, ledgerPath).then(
    ({ seats, caughtUpMs }) =>
      console.log(
        `[install] hrc-kernel bootstrap gate PASS: ${seats} seats, caught up in ${caughtUpMs} ms`
      ),
    (error: Error) => {
      console.error(error.message)
      process.exit(1)
    }
  )
}
