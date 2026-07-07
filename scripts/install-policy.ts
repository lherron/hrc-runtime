import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'

export type InstallContext = 'main' | 'linked-worktree'
export type PublishChannel = 'dev' | 'worktree'
export type SideEffectMode = 'on' | 'off' | 'forced'

export type InstallPolicy = {
  context: InstallContext
  syncMode: SideEffectMode
  linkMode: SideEffectMode
  publishChannel: PublishChannel
  publishTag: 'latest' | 'worktree'
}

type InstallPolicyInput = {
  context: InstallContext
  noSync?: string | boolean | undefined
  forceSync?: string | boolean | undefined
  forceLink?: string | boolean | undefined
}

function truthy(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === '') return false
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function resolveGitPath(repoRoot: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(repoRoot, path)
  if (!existsSync(absolute)) return normalize(absolute)
  return realpathSync.native(absolute)
}

export function detectContextFromGitDirs(
  repoRoot: string,
  gitDir: string,
  commonGitDir: string
): InstallContext {
  const resolvedGitDir = resolveGitPath(repoRoot, gitDir)
  const resolvedCommonGitDir = resolveGitPath(repoRoot, commonGitDir)
  return resolvedGitDir === resolvedCommonGitDir ? 'main' : 'linked-worktree'
}

export function detectInstallContext(repoRoot = process.cwd()): InstallContext {
  const gitDir = git(['rev-parse', '--git-dir'], repoRoot)
  const commonGitDir = git(['rev-parse', '--git-common-dir'], repoRoot)
  return detectContextFromGitDirs(repoRoot, gitDir, commonGitDir)
}

export function computeInstallPolicy(input: InstallPolicyInput): InstallPolicy {
  const explicitNoSync = truthy(input.noSync)
  const forceSync = truthy(input.forceSync)
  const forceLink = truthy(input.forceLink)

  if (explicitNoSync && forceSync) {
    throw new Error('no-sync and force-sync cannot both be enabled')
  }

  const isWorktree = input.context === 'linked-worktree'
  const syncMode: SideEffectMode = forceSync
    ? 'forced'
    : explicitNoSync || isWorktree
      ? 'off'
      : 'on'
  const linkMode: SideEffectMode = forceLink ? 'forced' : isWorktree ? 'off' : 'on'
  const publishChannel: PublishChannel = isWorktree ? 'worktree' : 'dev'

  return {
    context: input.context,
    syncMode,
    linkMode,
    publishChannel,
    publishTag: publishChannel === 'worktree' ? 'worktree' : 'latest',
  }
}

function shellValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function emitShell(policy: InstallPolicy): void {
  console.log(`PRAESIDIUM_INSTALL_CONTEXT=${shellValue(policy.context)}`)
  console.log(`PRAESIDIUM_INSTALL_SYNC_MODE=${shellValue(policy.syncMode)}`)
  console.log(`PRAESIDIUM_INSTALL_LINK_MODE=${shellValue(policy.linkMode)}`)
  console.log(`PRAESIDIUM_INSTALL_PUBLISH_CHANNEL=${shellValue(policy.publishChannel)}`)
  console.log(`PRAESIDIUM_INSTALL_PUBLISH_TAG=${shellValue(policy.publishTag)}`)
}

function parseCli(argv: string[]): {
  command: 'shell'
  noSync?: string
  forceSync?: string
  forceLink?: string
} {
  const [command = 'shell', ...rest] = argv
  if (command !== 'shell') throw new Error(`Unknown command: ${command}`)

  const options: { command: 'shell'; noSync?: string; forceSync?: string; forceLink?: string } = {
    command,
  }
  for (const arg of rest) {
    if (arg.startsWith('--no-sync=')) options.noSync = arg.slice('--no-sync='.length)
    else if (arg.startsWith('--force-sync=')) options.forceSync = arg.slice('--force-sync='.length)
    else if (arg.startsWith('--force-link=')) options.forceLink = arg.slice('--force-link='.length)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

if (import.meta.main) {
  const options = parseCli(process.argv.slice(2))
  const context = detectInstallContext()
  emitShell(
    computeInstallPolicy({
      context,
      noSync: options.noSync,
      forceSync: options.forceSync,
      forceLink: options.forceLink,
    })
  )
}
