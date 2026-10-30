// Drive the actual selected-snapshot builder, including real release cargo builds.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [builderPath, sourceRoot, first, second, artifacts] = process.argv.slice(2)
const { prepareNativeRelease } = await import(builderPath)
const drive = []
const run = async (command, args, cwd, overrides = {}) => {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      ([key]) => !/^(HARNESS_|TMUX|HRC_|ASP_|WRKQ|AGENT_|CLAUDE|CODEX)/.test(key)
    )
  )
  env.HRC_METRICS = '0'
  env.HRC_STATE_DIR = join(artifacts, 'cli-state')
  env.HRC_RUNTIME_DIR = join(artifacts, 'cli-run')
  const child = Bun.spawn([command, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const n = drive.length
  drive.push({ command, args, cwd, exit, stdout, stderr })
  await writeFile(join(artifacts, 'release-drive.json'), JSON.stringify(drive, null, 2))
  if (exit !== 0)
    throw new Error(`release command failed (${exit}): ${command}; see release-drive.json #${n}`)
}
const cargoCount = () => drive.filter((v) => v.command === 'cargo').length
await prepareNativeRelease(sourceRoot, first, join(artifacts, 'absent'), run)
if (cargoCount() !== 2) throw new Error('first release did not build both native binaries')
await prepareNativeRelease(sourceRoot, second, first, run)
if (cargoCount() !== 2) throw new Error('same-source release did not reuse its binaries')
const manifestPath = join(second, 'praesidium-release.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.hrcBuild.sourceCommit = 'f'.repeat(40)
await writeFile(manifestPath, JSON.stringify(manifest))
await prepareNativeRelease(sourceRoot, second, first, run)
if (cargoCount() !== 4) throw new Error('sourceCommit-only change reused an older executable')
const child = Bun.spawn([join(second, 'bin/rusthrc'), '--build-info'], {
  stdout: 'pipe',
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(HARNESS_|TMUX|HRC_|ASP_|WRKQ|AGENT_|CLAUDE|CODEX)/.test(key)
    )
  ),
})
const identity = JSON.parse(await new Response(child.stdout).text())
if (
  (await child.exited) !== 0 ||
  identity.owner !== 'rusthrc' ||
  identity.sourceCommit !== manifest.hrcBuild.sourceCommit
)
  throw new Error('snapshot binary embedded another sourceCommit')
manifest.hrcBuild.sourceCommit = 'invalid'
await writeFile(manifestPath, JSON.stringify(manifest))
let invalidRefused = false
try {
  await prepareNativeRelease(sourceRoot, second, first, run)
} catch (error) {
  invalidRefused = String(error).includes('valid selected sourceCommit')
}
if (!invalidRefused) throw new Error('invalid selected sourceCommit accepted')
const result = {
  pass: true,
  noGit: true,
  firstBuilds: 2,
  sameSourceReused: true,
  changedSourceRebuilt: true,
  actualCargoProfile: 'release',
  identity,
  invalidRefused,
}
await writeFile(join(artifacts, 'release-result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
