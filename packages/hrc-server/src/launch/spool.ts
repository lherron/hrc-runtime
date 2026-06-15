import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SpoolEntry = {
  seq: number
  payload: unknown
  path: string
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
    const filePath = join(launchSpoolDir, seqFilename(nextSeq))
    try {
      // `wx` (exclusive create) is load-bearing: it makes seq allocation atomic
      // against concurrent hook writers spooling to the same launchId. On EEXIST
      // we advance to the next seq and retry rather than overwrite.
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
    const seq = parseSeqFromFilename(file)
    if (seq === null) continue

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

async function readExistingSeqs(dir: string): Promise<number[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  return files.map((f) => parseSeqFromFilename(f)).filter((seq): seq is number => seq !== null)
}

function seqFilename(seq: number): string {
  return `${String(seq).padStart(6, '0')}.json`
}

function parseSeqFromFilename(file: string): number | null {
  if (!file.endsWith('.json')) {
    return null
  }

  const seq = Number.parseInt(file.replace('.json', ''), 10)
  return Number.isNaN(seq) ? null : seq
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
