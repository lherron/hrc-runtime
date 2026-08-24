const documentationExtensions = new Set(['.md', '.markdown', '.html', '.htm', '.txt'])
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

type HookName = 'pre-commit' | 'pre-push'

interface ChangeScope {
  paths: string[]
  deletionOnlyPush: boolean
  ambiguous: boolean
}

function git(args: string[], stdin?: string): Uint8Array {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: process.cwd(),
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`git ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout
}

function nulDelimitedPaths(output: Uint8Array): string[] {
  return Buffer.from(output).toString('utf8').split('\0').filter(Boolean)
}

function commitsForUpdate(localOid: string, remoteOid: string): string[] {
  const args = ['rev-list', localOid, '--not']
  if (isZeroOid(remoteOid)) {
    args.push('--remotes')
  } else {
    args.push(remoteOid)
  }
  return Buffer.from(git(args)).toString('utf8').trim().split('\n').filter(Boolean)
}

function pathsForCommits(commits: string[]): string[] {
  if (commits.length === 0) return []
  return nulDelimitedPaths(
    git(
      [
        'diff-tree',
        '--stdin',
        '--root',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '--diff-filter=ACMRD',
        '-m',
        '-r',
        '-z',
      ],
      `${commits.join('\n')}\n`
    )
  )
}

function preCommitScope(): ChangeScope {
  return {
    paths: nulDelimitedPaths(
      git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRD', '-z'])
    ),
    deletionOnlyPush: false,
    ambiguous: false,
  }
}

function validOid(value: string): boolean {
  return oidPattern.test(value)
}

function isZeroOid(value: string): boolean {
  return validOid(value) && /^0+$/.test(value)
}

async function prePushScope(): Promise<ChangeScope> {
  const input = await Bun.stdin.text()
  const lines = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { paths: [], deletionOnlyPush: false, ambiguous: true }

  const paths = new Set<string>()
  let sawUpdate = false
  let sawNonDeletion = false

  for (const line of lines) {
    const fields = line.split(/\s+/)
    if (fields.length !== 4) return { paths: [], deletionOnlyPush: false, ambiguous: true }
    const [localRef, localOid, remoteRef, remoteOid] = fields as [string, string, string, string]
    if (!validOid(localOid) || !validOid(remoteOid) || !remoteRef.startsWith('refs/')) {
      return { paths: [], deletionOnlyPush: false, ambiguous: true }
    }

    sawUpdate = true
    if (localRef === '(delete)' && isZeroOid(localOid) && !isZeroOid(remoteOid)) continue
    if (!localRef.startsWith('refs/') || isZeroOid(localOid)) {
      return { paths: [], deletionOnlyPush: false, ambiguous: true }
    }

    sawNonDeletion = true
    for (const path of pathsForCommits(commitsForUpdate(localOid, remoteOid))) paths.add(path)
  }

  return {
    paths: [...paths],
    deletionOnlyPush: sawUpdate && !sawNonDeletion,
    ambiguous: !sawUpdate,
  }
}

function isDocumentation(path: string): boolean {
  const slash = path.lastIndexOf('/')
  const basename = slash === -1 ? path : path.slice(slash + 1)
  const dot = basename.lastIndexOf('.')
  return dot !== -1 && documentationExtensions.has(basename.slice(dot).toLowerCase())
}

async function changeScope(hook: HookName): Promise<ChangeScope> {
  try {
    return hook === 'pre-commit' ? preCommitScope() : await prePushScope()
  } catch (error) {
    console.error(`[hook-scope] unable to inspect changes; running validation: ${error}`)
    return { paths: [], deletionOnlyPush: false, ambiguous: true }
  }
}

async function main(): Promise<number> {
  const separator = process.argv.indexOf('--', 2)
  const hook = process.argv[2]
  if ((hook !== 'pre-commit' && hook !== 'pre-push') || separator === -1) {
    console.error('usage: run-if-code-changed.ts <pre-commit|pre-push> -- <command> [args...]')
    return 2
  }
  const command = process.argv.slice(separator + 1)
  if (command.length === 0) {
    console.error('run-if-code-changed.ts requires a command after --')
    return 2
  }

  const scope = await changeScope(hook)
  if (scope.deletionOnlyPush) {
    console.log('[hook-scope] skipping validation for a deletion-only push')
    return 0
  }
  if (!scope.ambiguous && scope.paths.length > 0 && scope.paths.every(isDocumentation)) {
    console.log(
      `[hook-scope] skipping code validation for ${scope.paths.length} documentation file(s)`
    )
    return 0
  }

  const result = Bun.spawnSync(command, {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return result.exitCode
}

process.exit(await main())
