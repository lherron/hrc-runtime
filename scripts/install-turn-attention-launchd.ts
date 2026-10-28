import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Invoked only by the operator's install recipe. Never logs the environment/key.
const home = homedir()
const key = process.env['TYPESAFE_API_KEY']
if (!key) throw new Error('TYPESAFE_API_KEY must be exported in the install environment')
let version = process.argv[2]
if (version === 'latest')
  version = execFileSync('npm', ['view', 'hrc-turn-attention@latest', 'version'], {
    encoding: 'utf8',
  }).trim()
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version))
  throw new Error('an exact version or latest is required')
const status = JSON.parse(execFileSync('hrc', ['server', 'status', '--json'], { encoding: 'utf8' }))
if (!status.socketPath) throw new Error('HRC status missing socketPath')
const label = 'com.praesidium.hrc-turn-attention'
const plist = join(home, 'Library/LaunchAgents', `${label}.plist`)
await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true })
await mkdir(join(home, 'praesidium/var/logs/hrc-runtime'), { recursive: true })
const xmlEscape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
const values: Record<string, string> = {
  HOME: home,
  BUNX: join(home, '.bun/bin/bunx'),
  VERSION: version,
  SOCKET: status.socketPath,
  KEY: key,
  STATE: join(home, 'praesidium/var/state/turn-attention/cursor.json'),
}
let xml = await readFile(
  join(import.meta.dir, '../launchd/com.praesidium.hrc-turn-attention.plist'),
  'utf8'
)
for (const [name, value] of Object.entries(values))
  xml = xml.replaceAll(`__${name}__`, () => xmlEscape(value))
if (/__[A-Z_]+__/.test(xml)) throw new Error('unrendered plist placeholder')
const candidate = `${plist}.next`
await writeFile(candidate, xml, { mode: 0o600 })
await chmod(candidate, 0o600)
execFileSync('plutil', ['-lint', candidate], { stdio: 'ignore' })
// Adopt the rendered candidate before comparing, as install-mail-injector-launchd
// does, so the job runs under praesidium-launch like the other fleet daemons.
let adoptAvailable = true
try {
  execFileSync('sh', ['-c', 'command -v praesidium-adopt'], { stdio: 'ignore' })
} catch {
  adoptAvailable = false
}
if (adoptAvailable) execFileSync('praesidium-adopt', [candidate], { stdio: 'ignore' })
const adopted = await readFile(candidate, 'utf8')
const target = `gui/${process.getuid?.()}/${label}`
let loaded = false
try {
  execFileSync('launchctl', ['print', target], { stdio: 'ignore' })
  loaded = true
} catch {}
if (loaded && (await readFile(plist, 'utf8')) === adopted) {
  const { unlink } = await import('node:fs/promises')
  await unlink(candidate)
  console.log(`turn-attention already current at ${version}`)
} else {
  // launchd refuses a bootstrap that lands before the old job has finished
  // leaving, so wait for it to go and retry, as install-mail-injector-launchd does.
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const isLoaded = () => {
    try {
      execFileSync('launchctl', ['print', target], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  if (loaded) {
    execFileSync('launchctl', ['bootout', target], { stdio: 'ignore' })
    for (let i = 0; i < 50 && isLoaded(); i++) await sleep(200)
  }
  const { rename } = await import('node:fs/promises')
  await rename(candidate, plist)
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, plist], {
        stdio: 'ignore',
      })
      break
    } catch (error) {
      if (attempt === 5) throw new Error(`could not bootstrap ${target}`, { cause: error })
      await sleep(2000)
    }
  }
  console.log(`turn-attention supervised at ${version}`)
}
