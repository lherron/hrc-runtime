const [release, root] = process.argv.slice(2)
if (!root?.startsWith('/tmp/hrcp1-')) throw Error('scratch only')
const { openHrcDatabase } = await import(`${release}/packages/hrc-store-sqlite/src/index.ts`)
const db = openHrcDatabase(`${root}/state.sqlite`, { migrate: false })
const state = () => ({
  parts: db.sqlite
    .query(
      'SELECT blob_id AS blobId,part,parts,runtime_id AS runtimeId,kind,bytes,chunk FROM tool_result_blob_parts WHERE blob_id=? ORDER BY part'
    )
    .all('p1-part'),
  blob: db.toolResultBlobs.get('p1-part'),
})
const first = {
  blobId: 'p1-part',
  runtimeId: 'p1-blob-runtime',
  kind: 'broker_raw',
  bytes: 7,
  part: 0,
  parts: 2,
  chunk: '{"a":',
}
const invalid = { ...first, part: 1, chunk: '1}', bytes: 8 }
try {
  const boundaries = [{ stage: 'beforePart', state: state() }]
  const initial = db.toolResultBlobs.ingestPart(first)
  boundaries.push({ stage: 'afterFirstPart', state: state() })
  let error: { name: string; message: string } | undefined
  db.sqlite
    .transaction(() => {
      try {
        db.toolResultBlobs.ingestPart(invalid)
      } catch (e) {
        error = { name: e.name, message: e.message }
      }
      boundaries.push({ stage: 'withinCaughtInvalidPart', state: state() })
    })
    .immediate()
  boundaries.push({ stage: 'afterInvalidPart', state: state() })
  const complete = db.toolResultBlobs.ingestPart({ ...invalid, bytes: 7 })
  boundaries.push({ stage: 'afterCompletePart', state: state() })
  console.log(JSON.stringify({ boundaries, first, invalid, error, initial, complete }))
} finally {
  db.close()
}
