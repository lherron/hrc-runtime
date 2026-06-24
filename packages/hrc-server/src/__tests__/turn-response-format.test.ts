import { describe, expect, it } from 'bun:test'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  assertRuntimeSupportsResponseFormat,
  preflightDriverSupportsResponseFormat,
  toBrokerResponseFormat,
} from '../turn-response-format'

describe('turn response format support helpers', () => {
  it('treats omitted and text responseFormat as no-op broker input', () => {
    expect(toBrokerResponseFormat(undefined)).toBeUndefined()
    expect(toBrokerResponseFormat({ kind: 'text' })).toBeUndefined()
  })

  it('converts json_schema responseFormat to the broker wire shape', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
    expect(toBrokerResponseFormat({ kind: 'json_schema', schema })).toEqual({
      kind: 'json_schema',
      schema,
    })
  })

  it('rejects reused broker runtimes with missing finalResponse capability', () => {
    const runtime = {
      runtimeId: 'rt-test',
      activeInvocationId: 'inv-test',
      controllerKind: 'harness-broker',
      transport: 'headless',
    }
    const db = {
      brokerInvocations: {
        getByInvocationId: () => ({
          capabilitiesJson: JSON.stringify({ input: { queue: true } }),
        }),
      },
    } as unknown as HrcDatabase

    expect(() =>
      assertRuntimeSupportsResponseFormat({
        db,
        runtime: runtime as Parameters<typeof assertRuntimeSupportsResponseFormat>[0]['runtime'],
        route: 'broker',
        responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
      })
    ).toThrow('responseFormat json_schema is unsupported')
  })

  it('accepts reused broker runtimes with jsonSchema and perTurn support', () => {
    const runtime = {
      runtimeId: 'rt-test',
      activeInvocationId: 'inv-test',
      controllerKind: 'harness-broker',
      transport: 'headless',
    }
    const db = {
      brokerInvocations: {
        getByInvocationId: () => ({
          capabilitiesJson: JSON.stringify({
            finalResponse: {
              jsonSchema: true,
              perTurn: true,
              strict: true,
              parsedResult: false,
            },
          }),
        }),
      },
    } as unknown as HrcDatabase

    expect(() =>
      assertRuntimeSupportsResponseFormat({
        db,
        runtime: runtime as Parameters<typeof assertRuntimeSupportsResponseFormat>[0]['runtime'],
        route: 'broker',
        responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
      })
    ).not.toThrow()
  })

  it('preflights fresh broker driver summaries before invocation start', () => {
    const result = preflightDriverSupportsResponseFormat({
      route: 'broker',
      responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
      profile: { brokerDriver: 'codex-app-server' } as Parameters<
        typeof preflightDriverSupportsResponseFormat
      >[0]['profile'],
      hello: {
        drivers: [
          {
            kind: 'codex-app-server',
            version: 'test',
            available: true,
            capabilities: {
              finalResponse: {
                jsonSchema: true,
                perTurn: true,
                strict: true,
                parsedResult: false,
              },
            },
          },
        ],
      } as Parameters<typeof preflightDriverSupportsResponseFormat>[0]['hello'],
    })

    expect(result.ok).toBe(true)
  })
})
