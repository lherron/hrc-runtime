import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

let syncModule: Promise<typeof import('./lib/verdaccio-sync')> | undefined

async function loadSyncModule(): Promise<typeof import('./lib/verdaccio-sync')> {
  syncModule ??= (async () => {
    mock.module('node:child_process', () => ({
      spawnSync: () => ({
        status: 42,
        stdout: '',
        stderr: 'fake bun install reached\n',
      }),
    }))
    return await import('./lib/verdaccio-sync')
  })()
  return await syncModule
}

async function manifestUsing(packageName: string): Promise<{ dir: string; manifestPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'verdaccio-sync-test-'))
  const manifestPath = join(dir, 'package.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        name: 'verdaccio-sync-test-consumer',
        private: true,
        dependencies: {
          [packageName]: 'latest',
        },
      },
      null,
      2
    )}\n`
  )
  return { dir, manifestPath }
}

function serveLatest(version: string): void {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      'dist-tags': { latest: version },
      versions: { [version]: {} },
    }),
  })) as unknown as typeof fetch
}

async function syncFixture(packageName: string, latestVersion: string): Promise<void> {
  const { dir, manifestPath } = await manifestUsing(packageName)
  try {
    serveLatest(latestVersion)
    const { syncFromVerdaccio } = await loadSyncModule()
    await syncFromVerdaccio({
      label: 'TEST',
      lockName: '.verdaccio-sync-test.lock',
      groups: [{ label: 'TEST', packages: [packageName] }],
      manifestPaths: async () => [manifestPath],
      tmpPrefix: 'verdaccio-sync-test-install-',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('verdaccio sync install gate', () => {
  test('treats a tracked package missing from node_modules as not latest', async () => {
    // T-05948: just install wipes node_modules before sync; an absent tracked package
    // must force the install path instead of being skipped as "already latest".
    await expect(
      syncFixture('@praesidium/sync-missing-fixture-never-installed', '0.0.1-dev.20260708000000')
    ).rejects.toThrow(/fake bun install reached/)
  })

  test('still treats a stale installed package as not latest', async () => {
    await expect(syncFixture('@types/bun', '999.0.0-dev.20260708000000')).rejects.toThrow(
      /fake bun install reached/
    )
  })

  test('keeps the skip path when every tracked package is present and current', async () => {
    await expect(syncFixture('@types/bun', '1.3.14')).resolves.toBeUndefined()
  })
})
