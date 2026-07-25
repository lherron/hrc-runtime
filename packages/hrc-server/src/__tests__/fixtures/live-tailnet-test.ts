import { test } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { FederationConfig, PeerEntry } from '../../federation/federation-config.js'
import {
  FEDERATION_CONFIG_BASENAME,
  resolveFederationConfig,
} from '../../federation/federation-config.js'
import { createHrcServer } from '../../index.js'
import type { HrcServer, HrcServerOptions } from '../../server-types.js'
import type { HrcServerTestFixture } from './hrc-test-fixture.js'

export const REQUIRE_LIVE_TAILNET_TESTS_ENV = 'HRC_REQUIRE_LIVE_TAILNET_TESTS'
export const FEDERATION_TEST_MODE_ENV = 'HRC_FEDERATION_TEST_MODE'
export const FEDERATION_CASE_COUNTER_FILE_ENV = 'HRC_FEDERATION_CASE_COUNTER_FILE'
export const LIVE_TAILNET_SKIP_MARKER = 'HRC_LIVE_TAILNET_SKIP'
export const LIVE_TAILNET_REQUIRED_MARKER = 'HRC_LIVE_TAILNET_REQUIRED_MISSING'
export const FEDERATION_CORPUS_TEST_PREFIX = '[federation corpus]'
export const LOOPBACK_FEDERATION_CASE_MARKER = 'HRC_FEDERATION_LOOPBACK_CASE'

const LOOPBACK_TEST_HOST = '127.0.0.1'
const VALIDATION_TAILNET_HOST = '100.64.0.1'
const LOOPBACK_FETCH_PATCH = Symbol.for('hrc.test.federation-loopback-fetch-patch')
const FEDERATION_TEST_PROJECT_ROOT = resolve(import.meta.dir, '../../../../..')

export type LiveTailnetDisposition = 'run' | 'skip' | 'fail'

function isLoopbackMode(env: Record<string, string | undefined> = process.env): boolean {
  return env[FEDERATION_TEST_MODE_ENV] === 'loopback'
}

/**
 * Selects the fixture transport host. The loopback switch is consumed only by
 * test code; production config loading never reads it.
 */
export function federationTestHost(
  liveTailnetHost: string | undefined,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (!isLoopbackMode(env)) return liveTailnetHost
  installLoopbackFetchTransport()
  return LOOPBACK_TEST_HOST
}

export function liveTailnetDisposition(
  host: string | undefined,
  env: Record<string, string | undefined> = process.env
): LiveTailnetDisposition {
  if (host !== undefined) return 'run'
  return env[REQUIRE_LIVE_TAILNET_TESTS_ENV] === '1' ? 'fail' : 'skip'
}

function recordFederationCaseStart(
  file: string,
  label: string,
  env: Record<string, string | undefined>
): void {
  const counterFile = env[FEDERATION_CASE_COUNTER_FILE_ENV]
  if (counterFile === undefined) return
  appendFileSync(counterFile, `${file}\t${label}\n`)
  if (isLoopbackMode(env)) {
    console.info(`[${LOOPBACK_FEDERATION_CASE_MARKER}] ${file}: ${label}`)
  }
}

function wrapFederationCorpusTest(
  selectedTest: typeof test,
  file: string,
  env: Record<string, string | undefined>
): typeof test {
  const define = selectedTest as unknown as (
    label: string,
    body: () => unknown | Promise<unknown>,
    timeout?: number
  ) => void
  return ((label: string, body: () => unknown | Promise<unknown>, timeout?: number) =>
    define(
      `${FEDERATION_CORPUS_TEST_PREFIX} ${label}`,
      async () => {
        recordFederationCaseStart(file, label, env)
        await body()
      },
      timeout
    )) as typeof test
}

export function selectLiveTailnetTest(
  file: string,
  host: string | undefined,
  options: {
    env?: Record<string, string | undefined> | undefined
    warn?: ((message: string) => void) | undefined
  } = {}
): typeof test {
  const env = options.env ?? process.env
  const disposition = liveTailnetDisposition(host, env)
  if (disposition === 'run') return wrapFederationCorpusTest(test, file, env)

  const marker = disposition === 'fail' ? LIVE_TAILNET_REQUIRED_MARKER : LIVE_TAILNET_SKIP_MARKER
  const message = `[${marker}] ${file}: no tailnet IPv4 interface is available`
  const warn = options.warn ?? console.warn
  warn(message)
  return wrapFederationCorpusTest(disposition === 'fail' ? test : test.skip, file, env)
}

function rewriteUrlHost(raw: string, from: string, to: string): string {
  const url = new URL(raw)
  if (url.hostname === from) url.hostname = to
  const rewritten = url.toString()
  return raw.endsWith('/') ? rewritten : rewritten.replace(/\/$/, '')
}

function installLoopbackFetchTransport(): void {
  const globalWithPatch = globalThis as typeof globalThis & {
    [LOOPBACK_FETCH_PATCH]?: boolean | undefined
  }
  if (globalWithPatch[LOOPBACK_FETCH_PATCH]) return
  const nativeFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl =
      typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url)
    if (requestUrl.hostname !== VALIDATION_TAILNET_HOST) return nativeFetch(input, init)
    requestUrl.hostname = LOOPBACK_TEST_HOST
    const rewritten =
      input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl.toString()
    return nativeFetch(rewritten, init)
  }) as typeof fetch
  globalWithPatch[LOOPBACK_FETCH_PATCH] = true
}

/**
 * Gives direct fixture clients a production-valid origin while the test-only
 * fetch transport maps that reserved address to loopback.
 */
export function federationTestConfigUrl(
  transportUrl: string,
  env: Record<string, string | undefined> = process.env
): string {
  return isLoopbackMode(env)
    ? rewriteUrlHost(transportUrl, LOOPBACK_TEST_HOST, VALIDATION_TAILNET_HOST)
    : transportUrl
}

function validationDocument(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const document = structuredClone(value) as Record<string, unknown>
  const peers = document['peers']
  if (peers !== null && typeof peers === 'object' && !Array.isArray(peers)) {
    for (const peerValue of Object.values(peers)) {
      if (peerValue === null || typeof peerValue !== 'object' || Array.isArray(peerValue)) continue
      const peer = peerValue as Record<string, unknown>
      if (typeof peer['endpoint'] === 'string') {
        peer['endpoint'] = rewriteUrlHost(
          peer['endpoint'],
          LOOPBACK_TEST_HOST,
          VALIDATION_TAILNET_HOST
        )
      }
      if (typeof peer['registryEndpoint'] === 'string') {
        peer['registryEndpoint'] = rewriteUrlHost(
          peer['registryEndpoint'],
          LOOPBACK_TEST_HOST,
          VALIDATION_TAILNET_HOST
        )
      }
    }
  }
  for (const listenerKey of ['registry', 'peerListener']) {
    const listenerValue = document[listenerKey]
    if (
      listenerValue !== null &&
      typeof listenerValue === 'object' &&
      !Array.isArray(listenerValue)
    ) {
      const listener = listenerValue as Record<string, unknown>
      if (typeof listener['bind'] === 'string') {
        listener['bind'] = rewriteUrlHost(
          listener['bind'],
          LOOPBACK_TEST_HOST,
          VALIDATION_TAILNET_HOST
        )
      }
    }
  }
  return document
}

function loopbackTransportConfig(
  validated: FederationConfig,
  sourcePath: string
): FederationConfig {
  const peers = new Map(
    [...validated.peers].map(([nodeId, peer]): [typeof nodeId, PeerEntry] => [nodeId, peer])
  )
  return {
    ...validated,
    sourcePath,
    peers,
    ...(validated.registry === undefined
      ? {}
      : {
          registry: {
            bind: rewriteUrlHost(
              validated.registry.bind,
              VALIDATION_TAILNET_HOST,
              LOOPBACK_TEST_HOST
            ),
          },
        }),
    ...(validated.peerListener === undefined
      ? {}
      : {
          peerListener: {
            bind: rewriteUrlHost(
              validated.peerListener.bind,
              VALIDATION_TAILNET_HOST,
              LOOPBACK_TEST_HOST
            ),
          },
        }),
  }
}

async function resolveLoopbackFederationTestConfig(stateRoot: string): Promise<FederationConfig> {
  const sourcePath = join(stateRoot, FEDERATION_CONFIG_BASENAME)
  const raw = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown
  const validationRoot = await mkdtemp(join(tmpdir(), 'hrc-federation-validation-'))
  try {
    await writeFile(
      join(validationRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify(validationDocument(raw)),
      { mode: 0o600 }
    )
    const validated = await resolveFederationConfig({ stateRoot: validationRoot, env: {} })
    return loopbackTransportConfig(validated, sourcePath)
  } finally {
    await rm(validationRoot, { recursive: true, force: true })
  }
}

/**
 * Starts a real HRC instance for a corpus case. In loopback mode the fixture
 * validates an equivalent tailnet-addressed document with the production
 * parser, then substitutes only transport origins in the already-resolved
 * config. No production parser, env resolver, or bind law can reach this seam.
 */
export async function createFederationTestServer(
  fixture: HrcServerTestFixture,
  overrides: Partial<HrcServerOptions> = {}
): Promise<HrcServer> {
  const server = await (isLoopbackMode()
    ? createHrcServer(
        fixture.serverOpts({
          ...overrides,
          federationConfig: await resolveLoopbackFederationTestConfig(fixture.stateRoot),
        })
      )
    : createHrcServer(fixture.serverOpts(overrides)))

  // The verification envelope supplies an isolated ASP_AGENTS_ROOT. Give
  // federation fixtures an equally explicit checkout root so a linked
  // worktree whose directory has a task suffix does not fail project-id
  // matching and fabricate `<package cwd>/<project id>` as a sibling.
  Object.assign(server, {
    runtimeIntentLocalizationOptions: {
      cwd: FEDERATION_TEST_PROJECT_ROOT,
      env: {
        ...process.env,
        ASP_PROJECT_ROOT_OVERRIDE: FEDERATION_TEST_PROJECT_ROOT,
      },
    },
  })
  return server
}
