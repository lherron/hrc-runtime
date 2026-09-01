import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CORRUPT_SPOOL_DIRNAME = '.corrupt'

export type SpoolEntry = {
  seq: number
  payload: unknown
  path: string
}

export type CorruptSpoolEntry = {
  path: string
  quarantinePath: string | null
  error: unknown
  quarantineError?: unknown
}

export type ReadSpoolEntriesOptions = {
  onCorruptEntry?: (entry: CorruptSpoolEntry) => void
}

export async function spoolCallback(
  spoolDir: string,
  launchId: string,
  payload: object
): Promise<string> {
  const launchSpoolDir = join(spoolDir, launchId)
  await mkdir(launchSpoolDir, { recursive: true })

  const existing = await readAllocatedSeqs(launchSpoolDir)
  const serializedPayload = JSON.stringify(payload, null, 2)
  let nextSeq = existing.length > 0 ? Math.max(...existing) + 1 : 1

  while (true) {
    const filePath = join(launchSpoolDir, seqFilename(nextSeq))
    const reservationPath = join(launchSpoolDir, reservationFilename(nextSeq))
    try {
      // The reservation is deliberately not a `.json` file, so readers cannot
      // observe a partially-written payload. It remains until replay removes
      // the launch directory; releasing it here would let a slower concurrent
      // writer reclaim this seq after the rename and overwrite the final file.
      await writeFile(reservationPath, '', { flag: 'wx' })
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }

      nextSeq += 1
      continue
    }

    const tempPath = join(
      launchSpoolDir,
      `.${seqFilename(nextSeq)}.${process.pid}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(tempPath, serializedPayload, {
        encoding: 'utf-8',
        flag: 'wx',
      })
      await rename(tempPath, filePath)
      return filePath
    } finally {
      await Promise.allSettled([unlink(tempPath)])
    }
  }
}

export async function readSpoolEntries(
  spoolDir: string,
  launchId: string,
  options: ReadSpoolEntriesOptions = {}
): Promise<SpoolEntry[]> {
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
    try {
      const raw = await readFile(filePath, 'utf-8')
      entries.push({
        seq,
        payload: JSON.parse(raw),
        path: filePath,
      })
    } catch (error) {
      try {
        const quarantinePath = await quarantineCorruptEntry(spoolDir, launchId, file, filePath)
        options.onCorruptEntry?.({ path: filePath, quarantinePath, error })
      } catch (quarantineError) {
        options.onCorruptEntry?.({
          path: filePath,
          quarantinePath: null,
          error,
          quarantineError,
        })
      }
    }
  }

  return entries
}

async function readAllocatedSeqs(dir: string): Promise<number[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  return files
    .map((file) => parseAllocatedSeqFromFilename(file))
    .filter((seq): seq is number => seq !== null)
}

function seqFilename(seq: number): string {
  return `${String(seq).padStart(6, '0')}.json`
}

function reservationFilename(seq: number): string {
  return `${String(seq).padStart(6, '0')}.reserve`
}

function parseSeqFromFilename(file: string): number | null {
  if (!file.endsWith('.json')) {
    return null
  }

  const seq = Number.parseInt(file.replace('.json', ''), 10)
  return Number.isNaN(seq) ? null : seq
}

function parseAllocatedSeqFromFilename(file: string): number | null {
  if (file.endsWith('.reserve')) {
    const seq = Number.parseInt(file.replace('.reserve', ''), 10)
    return Number.isNaN(seq) ? null : seq
  }
  return parseSeqFromFilename(file)
}

async function quarantineCorruptEntry(
  spoolDir: string,
  launchId: string,
  file: string,
  filePath: string
): Promise<string> {
  const quarantineDir = join(spoolDir, CORRUPT_SPOOL_DIRNAME, launchId)
  await mkdir(quarantineDir, { recursive: true })
  const quarantinePath = join(quarantineDir, `${file}.corrupt-${randomUUID()}`)
  await rename(filePath, quarantinePath)
  return quarantinePath
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
