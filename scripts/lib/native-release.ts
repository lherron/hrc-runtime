import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

// Reuse only when source identity, Rust/shared bytes, and target match. A TS-only
// atomic release still receives both native binaries.
async function inputDigest(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'praesidium-release.json'), 'utf8'))
  const sourceCommit: unknown = manifest.hrcBuild?.sourceCommit
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error('Rust release requires a valid selected sourceCommit')
  }
  // rusthrc embeds this identity even for a TS-only release. Reusing a binary
  // from another commit would either lie about ownership or refuse startup.
  const hash = createHash('sha256').update(`${process.platform}/${process.arch}\0${sourceCommit}\0`)
  async function visit(path: string): Promise<void> {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!info.isDirectory()) {
      hash
        .update(relative(root, path))
        .update('\0')
        .update(await readFile(path))
        .update('\0')
      return
    }
    for (const name of (await readdir(path)).sort()) {
      if (name !== 'target') await visit(join(path, name))
    }
  }
  for (const dir of [
    'crates',
    // Rust build scripts read these selected release inputs too.
    'packages/hrc-core/package.json',
    'packages/hrc-core/src/self-restart.ts',
    'packages/hrc-server/src/server-exact-routes.ts',
    'packages/hrc-server/src/request-log.ts',
    'packages/hrc-server/src/request-metrics.ts',
    'contract',
    'conformance',
    'packages/hrc-store-sqlite/src/migrations',
    'packages/hrc-store-sqlite/src/migrations.ts',
  ]) {
    await visit(join(root, dir))
  }
  return hash.digest('hex')
}

export async function prepareNativeRelease(
  sourceRoot: string,
  releasePath: string,
  previousRelease: string,
  run: (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<void>
): Promise<void> {
  const digest = await inputDigest(releasePath)
  // hrc-pty is the per-seat supervisor rusthrc starts from beside itself (T-12046).
  for (const [binary, crate, probe] of [
    ['rusthrc', 'hrc-native', '--help'],
    ['hrc-pty', 'hrc-pty', 'version'],
  ] as const) {
    const destination = join(releasePath, 'bin', binary)
    await mkdir(join(releasePath, 'bin'), { recursive: true })
    let reusable = false
    try {
      reusable =
        (await readFile(join(previousRelease, 'bin', `${binary}.inputs`), 'utf8')).trim() === digest
      if (reusable) await copyFile(join(previousRelease, 'bin', binary), destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      reusable = false
    }
    if (reusable) {
      console.log(`[install] Rust/shared inputs unchanged; reusing ${binary}`)
    } else {
      console.log(`[install] building ${binary} from selected release inputs`)
      await run(
        'cargo',
        ['build', '--release', '--locked', '--manifest-path', 'crates/Cargo.toml', '-p', crate],
        releasePath,
        {
          ...process.env,
          CARGO_TARGET_DIR: join(sourceRoot, 'crates', 'target'),
        }
      )
      await copyFile(join(sourceRoot, 'crates', 'target', 'release', binary), destination)
    }
    await chmod(destination, 0o755)
    await writeFile(join(releasePath, 'bin', `${binary}.inputs`), `${digest}\n`)
    await run(destination, [probe], releasePath)
  }
}
