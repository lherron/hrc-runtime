import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_STORAGE_KIND,
  HRC_PROVIDER_TRANSCRIPT_REPORTED_EVENT,
} from 'hrc-core'
import {
  PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
  PROVIDER_TRANSCRIPT_MEDIA_TYPE,
  PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE,
  PROVIDER_TRANSCRIPT_SCHEMA,
  PROVIDER_TRANSCRIPT_STORAGE,
  validateEventEnvelope,
} from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  GENERATION,
  INVOCATION_ID,
  OPERATION_ID,
  RUNTIME_ID,
  RUN_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
} from './broker-event-mapper-fixtures'

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeSeededFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-05375 provider transcript protocol drift proof', () => {
  it('matches the ASP producer protocol and carries its content schema separately from HRC metadata', async () => {
    expect(HRC_PROVIDER_TRANSCRIPT_REPORTED_EVENT).toBe(PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE)
    expect(HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND).toBe(PROVIDER_TRANSCRIPT_ARTIFACT_KIND)
    expect(HRC_PROVIDER_TRANSCRIPT_ARTIFACT_MEDIA_TYPE).toBe(PROVIDER_TRANSCRIPT_MEDIA_TYPE)
    expect(HRC_PROVIDER_TRANSCRIPT_ARTIFACT_STORAGE_KIND).toBe(PROVIDER_TRANSCRIPT_STORAGE)

    const dir = await mkdtemp(join(tmpdir(), 'hrc-provider-transcript-drift-'))
    try {
      const transcriptPath = join(dir, 'provider-transcript.jsonl')
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ jsonrpc: '2.0', method: 'codex/event', params: { ok: true } })}\n`,
        'utf8'
      )

      const producerEnvelope = envelope(
        PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE,
        8,
        {
          kind: PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
          artifactPath: transcriptPath,
          provider: 'codex',
          harnessGeneration: GENERATION,
        },
        { harnessGeneration: GENERATION }
      )

      expect(validateEventEnvelope(producerEnvelope)).toBe(producerEnvelope)
      expect(() =>
        validateEventEnvelope(
          envelope(
            PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE,
            9,
            {
              kind: PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
              path: transcriptPath,
              provider: 'codex',
            },
            { harnessGeneration: GENERATION }
          )
        )
      ).toThrow()

      new BrokerEventMapper({ db: fixture.db, now: () => '2026-06-30T00:00:00.000Z' }).apply(
        producerEnvelope
      )

      const artifacts = fixture.db.runtimeArtifacts.listByOperationIdAndKind(
        OPERATION_ID,
        PROVIDER_TRANSCRIPT_ARTIFACT_KIND
      )
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]).toMatchObject({
        operationId: OPERATION_ID,
        artifactKind: PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
        storageKind: PROVIDER_TRANSCRIPT_STORAGE,
        mediaType: PROVIDER_TRANSCRIPT_MEDIA_TYPE,
        artifactPath: transcriptPath,
      })

      const metadata = JSON.parse(artifacts[0]!.artifactJson ?? '{}') as Record<string, unknown>
      expect(metadata).toMatchObject({
        schema: HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA,
        sourceSchema: PROVIDER_TRANSCRIPT_SCHEMA,
        invocationId: INVOCATION_ID,
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        brokerSeq: 8,
        hashAlgorithm: 'sha256',
      })
      expect(metadata['schema']).not.toBe(PROVIDER_TRANSCRIPT_SCHEMA)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
