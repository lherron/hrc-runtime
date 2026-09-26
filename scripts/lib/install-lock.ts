import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/** Serialize release selection and selected-release publication on one durable lock. */
export async function acquireInstallLock(
  lockDir: string,
  sourceRoot: string
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockDir), { recursive: true })
  try {
    await mkdir(lockDir)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    const owner = await readFile(join(lockDir, 'owner.json'), 'utf8').catch(
      () => 'owner unavailable'
    )
    throw new Error(`install already in progress; lock ${lockDir} is held (${owner.trim()})`)
  }

  const token = randomUUID()
  await writeFile(
    join(lockDir, 'owner.json'),
    JSON.stringify({ token, pid: process.pid, sourceRoot, startedAt: new Date().toISOString() })
  )

  return async () => {
    const owner = await readFile(join(lockDir, 'owner.json'), 'utf8').catch(() => '')
    if (owner && !owner.includes(token)) {
      throw new Error(
        `refusing to release an install lock now owned by another process: ${lockDir}`
      )
    }
    await rm(lockDir, { recursive: true })
  }
}
