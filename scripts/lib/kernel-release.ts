import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

// Reuse only when the exact Rust/shared input bytes and target match. A TS-only
// atomic release still receives the binary; it never silently omits the kernel.
async function inputDigest(root: string): Promise<string> {
  const hash = createHash('sha256').update(`${process.platform}/${process.arch}\0`)
  async function visit(path: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of entries.sort()) {
      if (name === 'target') continue
      const file = join(path, name)
      if ((await stat(file)).isDirectory()) await visit(file)
      else
        hash
          .update(relative(root, file))
          .update('\0')
          .update(await readFile(file))
          .update('\0')
    }
  }
  for (const dir of [
    'crates',
    'contract',
    'conformance',
    'packages/hrc-store-sqlite/src/migrations',
  ]) {
    await visit(join(root, dir))
  }
  return hash.digest('hex')
}

export async function prepareKernelRelease(
  sourceRoot: string,
  releasePath: string,
  previousRelease: string,
  run: (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<void>
): Promise<void> {
  const digest = await inputDigest(releasePath)
  const destination = join(releasePath, 'bin', 'hrc-kernel')
  await mkdir(join(releasePath, 'bin'), { recursive: true })
  let reusable = false
  try {
    reusable =
      (await readFile(join(previousRelease, 'bin', 'hrc-kernel.inputs'), 'utf8')).trim() === digest
    if (reusable) await copyFile(join(previousRelease, 'bin', 'hrc-kernel'), destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    reusable = false
  }
  if (reusable) {
    console.log('[install] Rust/shared inputs unchanged; reusing hrc-kernel')
  } else {
    console.log('[install] building hrc-kernel from selected release inputs')
    await run(
      'cargo',
      [
        'build',
        '--release',
        '--locked',
        '--manifest-path',
        'crates/Cargo.toml',
        '-p',
        'hrc-kernel',
      ],
      releasePath,
      {
        ...process.env,
        CARGO_TARGET_DIR: join(sourceRoot, 'crates', 'target'),
      }
    )
    await copyFile(join(sourceRoot, 'crates', 'target', 'release', 'hrc-kernel'), destination)
  }
  await chmod(destination, 0o755)
  await writeFile(join(releasePath, 'bin', 'hrc-kernel.inputs'), `${digest}\n`)
  await run(destination, ['--help'], releasePath)
}
