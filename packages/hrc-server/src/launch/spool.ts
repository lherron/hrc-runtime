import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { postCallback } from './callback-client.js'

export type SpoolEntry = {
  seq: number
  payload: unknown
  path: string
}

export type SpoolPostCallback = (
  socketPath: string,
  endpoint: string,
  payload: object
) => Promise<boolean>

export type SpoolReplayResult = {
  attempted: number
  delivered: number
  retained: number
}

export async function spoolCallback(
  spoolDir: string,
  launchId: string,
  payload: object
): Promise<string> {
  const launchSpoolDir = join(spoolDir, launchId)
  await mkdir(launchSpoolDir, { recursive: true })

  const existing = await readExistingSeqs(launchSpoolDir)
  const serializedPayload = JSON.stringify(payload, null, 2)
  let nextSeq = existing.length > 0 ? Math.max(...existing) + 1 : 1

  while (true) {
    const filePath = join(launchSpoolDir, `${String(nextSeq).padStart(6, '0')}.json`)
    try {
      await writeFile(filePath, serializedPayload, {
        encoding: 'utf-8',
        flag: 'wx',
      })
      return filePath
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }

      nextSeq += 1
    }
  }
}

export async function readSpoolEntries(spoolDir: string, launchId: string): Promise<SpoolEntry[]> {
  const launchSpoolDir = join(spoolDir, launchId)

  let files: string[]
  try {
    files = await readdir(launchSpoolDir)
  } catch {
    return []
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json')).sort()

  const entries: SpoolEntry[] = []
  for (const file of jsonFiles) {
    const seq = Number.parseInt(file.replace('.json', ''), 10)
    if (Number.isNaN(seq)) continue

    const filePath = join(launchSpoolDir, file)
    const raw = await readFile(filePath, 'utf-8')
    entries.push({
      seq,
      payload: JSON.parse(raw),
      path: filePath,
    })
  }

  return entries
}

export async function replaySpoolEntries(
  spoolDir: string,
  launchId: string,
  socketPath: string,
  post: SpoolPostCallback = postCallback
): Promise<SpoolReplayResult> {
  const entries = await readSpoolEntries(spoolDir, launchId)
  let delivered = 0

  for (const entry of entries) {
    const payload = parseReplayPayload(entry.payload, entry.path)
    const didDeliver = await post(socketPath, payload.endpoint, payload.payload)

    if (!didDeliver) {
      continue
    }

    await unlink(entry.path)
    delivered += 1
  }

  const retained = entries.length - delivered
  if (entries.length > 0 && retained === 0) {
    await rm(join(spoolDir, launchId), { recursive: true, force: true })
  }

  return {
    attempted: entries.length,
    delivered,
    retained,
  }
}

async function readExistingSeqs(dir: string): Promise<number[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => Number.parseInt(f.replace('.json', ''), 10))
    .filter((n) => !Number.isNaN(n))
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function parseReplayPayload(payload: unknown, path: string): { endpoint: string; payload: object } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`invalid spool entry payload in ${path}`)
  }

  const record = payload as Record<string, unknown>
  const endpoint = record['endpoint']
  const replayPayload = record['payload']

  if (typeof endpoint !== 'string') {
    throw new Error(`spool entry endpoint must be a string in ${path}`)
  }
  if (!replayPayload || typeof replayPayload !== 'object' || Array.isArray(replayPayload)) {
    throw new Error(`spool entry payload.body must be an object in ${path}`)
  }

  return {
    endpoint,
    payload: replayPayload,
  }
}
