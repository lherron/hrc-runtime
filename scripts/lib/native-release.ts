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
    // The one file outside crates/ a Rust build reads (include_str! in
    // crates/hrc-cli/src/admin/events_drain.rs), and the checked-in contract
    // identity the native suites pin.
    'packages/hrc-core/package.json',
    'contract',
    'conformance',
  ]) {
    await visit(join(root, dir))
  }
  return hash.digest('hex')
}

// On Apple silicon the release compiles on build1 through rbuild (arris), to
// keep that load off this machine: cross-built for aarch64-apple-darwin from
// the same selected release tree (its praesidium-release.json carries the
// sourceCommit build.rs stamps; rbuild mirrors it to the same absolute path,
// so embedded paths match too) and pulled back. rbuild builds here when
// build1 is down. The target dir is passed as an argument because rbuild does
// not forward the environment. Without rbuild it builds here the same way;
// other platforms build natively as before.
const MAC_TARGET = 'aarch64-apple-darwin'

async function buildReleaseBinary(
  sourceRoot: string,
  releasePath: string,
  crate: string,
  binary: string,
  run: (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<void>
): Promise<string> {
  const targetDir = join(sourceRoot, 'crates', 'target')
  const cargo = [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    'crates/Cargo.toml',
    '-p',
    crate,
  ]
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    await run('cargo', cargo, releasePath, env)
    return join(targetDir, 'release', binary)
  }
  const built = join(targetDir, MAC_TARGET, 'release', binary)
  const rbuild = Bun.which('rbuild')
  if (rbuild === null) {
    await run(
      'cargo',
      [...cargo, '--target', MAC_TARGET, '--target-dir', targetDir],
      releasePath,
      env
    )
  } else {
    await run(
      rbuild,
      ['--mac', '--pull', built, 'cargo', ...cargo, '--target-dir', targetDir],
      releasePath,
      env
    )
  }
  return built
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
      await copyFile(
        await buildReleaseBinary(sourceRoot, releasePath, crate, binary, run),
        destination
      )
    }
    await chmod(destination, 0o755)
    await writeFile(join(releasePath, 'bin', `${binary}.inputs`), `${digest}\n`)
    await run(destination, [probe], releasePath)
  }
}
