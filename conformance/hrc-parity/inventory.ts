import { execFileSync } from 'node:child_process'
/** Source discovery only. Does not construct a daemon or parse a CLI action. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildProgram } from '../../packages/hrc-cli/src/cli/build-program.js'
import { EVENT_INGEST_ROUTE_KEYS } from '../../packages/hrc-server/src/event-ingest/protocol.js'
import { PEER_PROTOCOL_ROUTE_KEYS } from '../../packages/hrc-server/src/federation/peer-protocol.js'
import { BINDING_REGISTRY_ROUTE_KEYS } from '../../packages/hrc-server/src/federation/registry-endpoint.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const index = process.argv.indexOf('--source-ref')
const ref = index < 0 ? 'HEAD' : process.argv[index + 1]
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
const commit = git('rev-parse', ref).trim()
// Tests inspect staged edits too; the gate always defaults to committed HEAD.
const workingTree = process.argv.includes('--working-tree')
const files = (workingTree ? git('ls-files') : git('ls-tree', '-r', '--name-only', commit))
  .trim()
  .split('\n')
const texts = new Map<string, string>()
const asts = new Map<string, ts.SourceFile>()
const unresolved: string[] = []
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
function source(path: string): ts.SourceFile {
  const old = asts.get(path)
  if (old) return old
  const text = workingTree
    ? readFileSync(`${root}/${path}`, 'utf8')
    : git('show', `${commit}:${path}`)
  texts.set(path, text)
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  asts.set(path, ast)
  if (
    /\.tsx?$/.test(path) &&
    (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length
  )
    unresolved.push(`TypeScript parse failure: ${path}`)
  return ast
}
function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, (n) => walk(n, visit))
}
function string(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined
}
function name(node: ts.Node | undefined): string {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : ''
}
function enclosing(node: ts.Node): string {
  let parent = node.parent
  const names: string[] = []
  while (parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isVariableDeclaration(parent)
    ) {
      const value = parent.name && name(parent.name)
      if (value) names.unshift(value)
    }
    parent = parent.parent
  }
  return names.join('.') || '<module>'
}
type Item = {
  id: string
  kind: string
  source: { path: string; symbol: string; line: number; hash: string }
  [key: string]: unknown
}
const items: Item[] = []
function add(
  id: string,
  kind: string,
  path: string,
  node: ts.Node | undefined,
  extra: Record<string, unknown> = {}
) {
  const ast = source(path)
  const line = node ? ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 : 1
  items.push({
    id,
    kind,
    source: {
      path,
      symbol: node ? enclosing(node) : '<module>',
      line,
      hash: sha(texts.get(path) ?? ''),
    },
    ...extra,
  })
}
const routeSource = 'packages/hrc-server/src/server-exact-routes.ts'
walk(source(routeSource), (n) => {
  if (!ts.isCallExpression(n) || name(n.expression) !== 'exactRouteKey') return
  const method = string(n.arguments[0])
  let path = string(n.arguments[1])
  if (
    n.arguments[1] &&
    ts.isIdentifier(n.arguments[1]) &&
    n.arguments[1].text === 'HRC_RESTART_SELF_PATH'
  ) {
    const constants = source('packages/hrc-core/src/self-restart.ts')
    walk(constants, (c) => {
      if (ts.isVariableDeclaration(c) && name(c.name) === 'HRC_RESTART_SELF_PATH')
        path = string(c.initializer)
    })
  }
  if (!method || !path) {
    unresolved.push(`Unresolved exactRouteKey at ${n.pos}`)
    return
  }
  add(`public:${method}:${path}`, 'public-exact', routeSource, n, {
    method,
    path,
    transport: 'public-unix',
    variants: ['positive', 'malformed', 'wrong-method', 'effects'],
  })
})
const computed = 'packages/hrc-server/src/runtime-list-handlers.ts'
walk(source(computed), (n) => {
  if (!ts.isObjectLiteralExpression(n)) return
  const props = new Map(
    n.properties.filter(ts.isPropertyAssignment).map((p) => [name(p.name), p.initializer])
  )
  if (!props.has('pathname') || !props.has('method')) return
  const path = string(props.get('pathname'))
  const method = string(props.get('method'))
  if (!path || !method) {
    unresolved.push(`Unresolved computed route at ${computed}:${n.pos}`)
    return
  }
  add(`public:${method}:${path}`, 'public-computed', computed, n, {
    path,
    method,
    transport: 'public-unix',
  })
})
// Pattern registrations are extracted from the live metrics matcher table below.
const metricsSource = 'packages/hrc-server/src/request-metrics.ts'
walk(source(metricsSource), (n) => {
  if (!ts.isObjectLiteralExpression(n)) return
  const props = new Map(
    n.properties.filter(ts.isPropertyAssignment).map((p) => [name(p.name), p.initializer])
  )
  const method = string(props.get('method'))
  const path = string(props.get('route'))
  if (!props.has('matches') || !props.has('route')) return
  if (!method || !path) {
    unresolved.push(`Unresolved pattern route at ${metricsSource}:${n.pos}`)
    return
  }
  add(`public:${method}:${path}`, 'public-pattern', metricsSource, n, {
    method,
    path,
    transport: 'public-unix',
  })
})
for (const file of ['server-request-methods.ts', 'server-routing.ts', 'input-handlers.ts']) {
  add(
    `dispatch-source:${file}`,
    'dispatch-source-fence',
    `packages/hrc-server/src/${file}`,
    undefined,
    { requirement: 'Matcher/guard source discovery' }
  )
}
// Read the executable registration sets, including computed entries. These sets
// construct no daemon and run no handler. Fence their source against source-ref
// structurally, so uncommitted comments do not change the discovered route set.
const printer = ts.createPrinter({ removeComments: true })
for (const [listener, path, keys] of [
  ['peer', 'packages/hrc-server/src/federation/peer-protocol.ts', PEER_PROTOCOL_ROUTE_KEYS],
  [
    'registry',
    'packages/hrc-server/src/federation/registry-endpoint.ts',
    BINDING_REGISTRY_ROUTE_KEYS,
  ],
  ['ingest', 'packages/hrc-server/src/event-ingest/protocol.ts', EVENT_INGEST_ROUTE_KEYS],
] as const) {
  const ast = source(path)
  const live = ts.createSourceFile(
    path,
    readFileSync(`${root}/${path}`, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  if (printer.printFile(ast) !== printer.printFile(live))
    unresolved.push(`Listener introspection does not match source-ref: ${path}`)
  const registered = new Set<string>()
  for (const key of keys) {
    const match = /^([A-Z]+) (\/v1\/\S+)$/.exec(key)
    if (!match) {
      unresolved.push(`Unresolved listener registration: ${listener} ${key}`)
      continue
    }
    const [, method, route] = match
    registered.add(route)
    add(`${listener}:${method}:${route}`, 'auxiliary-route', path, undefined, {
      method,
      path: route,
      transport: listener,
      variants: ['authenticated-positive', 'wrong-token', 'wrong-method', 'malformed', 'effects'],
    })
  }
  const dispatchPath =
    listener === 'ingest' ? 'packages/hrc-server/src/event-ingest/listener.ts' : path
  const discovered = new Set<string>()
  walk(source(dispatchPath), (n) => {
    const route = string(n)
    if (!route?.startsWith('/v1/') || discovered.has(route)) return
    discovered.add(route)
    if (route.endsWith('/')) {
      add(`${listener}:dispatch-prefix:${route}`, 'listener-dispatch-prefix', dispatchPath, n, {
        path: route,
        requirement: 'Dispatch-prefix behavior and unknown suffix refusals',
      })
    } else if (!registered.has(route)) {
      unresolved.push(`Listener path without a resolved registration: ${listener} ${route}`)
    }
  })
  add(`${listener}:dispatch-source`, 'dispatch-source-fence', dispatchPath, undefined)
}
// Capture the actual Commander graph, including ancestry, aliases, argument and
// option declarations. Never call parse/parseAsync or any command handler.
for (const path of files.filter(
  (p) => p.startsWith('packages/hrc-cli/src/') && p.endsWith('.ts') && !p.includes('/__tests__/')
)) {
  if (
    !workingTree &&
    readFileSync(`${root}/${path}`, 'utf8') !== texts.get(path) &&
    readFileSync(`${root}/${path}`, 'utf8') !== git('show', `${commit}:${path}`)
  ) {
    unresolved.push(`CLI introspection does not match source-ref: ${path}`)
  }
}
function commandTree(command: ReturnType<typeof buildProgram>, parents: string[]) {
  const ancestry = [...parents, command.name()]
  const path = 'packages/hrc-cli/src/cli/build-program.ts'
  add(`cli:${ancestry.join(' ')}`, 'cli-command', path, undefined, {
    ancestry,
    aliases: command.aliases(),
    description: command.description(),
    arguments: command.registeredArguments.map((a) => ({
      name: a.name(),
      required: a.required,
      variadic: a.variadic,
    })),
    options: command.options.map((o) => ({
      flags: o.flags,
      required: o.required,
      optional: o.optional,
      defaultValue: o.defaultValue,
      choices: o.argChoices,
      negate: o.negate,
    })),
    variants: ['help-agent', 'help-human', 'error', 'json', 'ndjson', 'exit', 'pty-if-applicable'],
  })
  for (const alias of command.aliases())
    add(`cli-alias:${[...parents, alias].join(' ')}`, 'cli-alias', path, undefined, {
      aliasOf: `cli:${ancestry.join(' ')}`,
    })
  for (const child of command.commands) commandTree(child, ancestry)
}
commandTree(buildProgram(), [])
for (const path of files) {
  if (path.startsWith('packages/') && path.endsWith('/package.json')) {
    const pkg = JSON.parse(
      workingTree ? readFileSync(`${root}/${path}`, 'utf8') : git('show', `${commit}:${path}`)
    )
    for (const [key, value] of Object.entries(pkg.exports ?? {}))
      add(`export:${pkg.name}:${key}`, 'package-export', path, undefined, {
        conditions: value,
      })
    for (const [key, value] of Object.entries(pkg.bin ?? {}))
      add(`bin:${key}`, 'package-bin', path, undefined, { entry: value })
  }
  if (!path.endsWith('.ts') || path.includes('/__tests__/')) continue
  if (path.startsWith('packages/hrc-store-sqlite/src/')) {
    const ast = source(path)
    add(`store-source:${path}`, 'store-source', path, undefined)
    walk(ast, (n) => {
      if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) {
        const symbol = name(n.name)
        if (symbol)
          add(
            `store-op:${path}:${enclosing(n)}:${symbol}:${n.getStart(ast)}`,
            'store-operation',
            path,
            n,
            { operation: symbol, declaration: n.getText(ast).split('{')[0] }
          )
      }
      if (
        ts.isStringLiteralLike(n) &&
        /CREATE\s+(TABLE|INDEX|TRIGGER|VIRTUAL)|ALTER\s+TABLE/i.test(n.text)
      ) {
        add(`schema-sql:${path}:${n.getStart(ast)}`, 'schema-sql', path, n, {
          sql: n.text,
        })
      }
    })
  }
  if (path.startsWith('packages/hrc-server/src/')) {
    const ast = source(path)
    walk(ast, (n) => {
      if (!ts.isCallExpression(n)) return
      const callee = n.expression.getText(ast)
      if (/\b(setInterval|setTimeout)$/.test(callee))
        add(`timer:${path}:${n.getStart(ast)}`, 'job-timer', path, n, {
          callee,
          cadence: n.arguments[1]?.getText(ast) ?? 'unspecified',
          requirement: 'Startup/trigger, one executor, recovery, shutdown and durable effects',
        })
      if (
        path.endsWith('/index.ts') &&
        /\b(start[A-Z]|warmDurable|scheduleExternal|recoverCold)/.test(callee)
      ) {
        add(`startup:${path}:${n.getStart(ast)}:${n.end}`, 'startup-job', path, n, {
          callee,
        })
      }
    })
  }
}
// Direct HRC consumers and writers are call-site inventories, not a historic
// six-command list. Private ACP stores are outside this source ownership.
for (const path of files.filter(
  (p) =>
    p.endsWith('.ts') &&
    !p.includes('/__tests__/') &&
    !p.endsWith('.test.ts') &&
    (p.startsWith('packages/hrc-cli/') ||
      p.startsWith('packages/hrc-capture-verifier/') ||
      p.startsWith('scripts/'))
)) {
  const ast = source(path)
  walk(ast, (n) => {
    if (
      ts.isCallExpression(n) &&
      /(?:openHrcDatabase|openReadonlyHrcDatabase|openDatabase|new Database|\.setCorrelationJson|\.query|\.prepare)$/.test(
        n.expression.getText(ast)
      )
    ) {
      add(`direct:${path}:${n.getStart(ast)}`, 'direct-store-call', path, n, {
        expression: n.expression.getText(ast),
        requirement:
          'Resolve exact DB, SQL columns, reader/writer effects and valid nonempty subject',
      })
    }
    if (ts.isNewExpression(n) && name(n.expression) === 'Database')
      add(`direct-open:${path}:${n.getStart(ast)}`, 'direct-store-open', path, n, {
        arguments: n.arguments?.map((a) => a.getText(ast)),
      })
  })
}
// File recovery overlay: each is an explicit format and lifecycle obligation.
for (const [id, path] of [
  ['state-wal-shm', 'packages/hrc-store-sqlite/src/database.ts'],
  ['registry-db', 'packages/hrc-server/src/federation/registry-endpoint.ts'],
  ['ingest-spool-forward-cursors', 'packages/hrc-server/src/event-ingest/listener.ts'],
  ['session-publication-cursor', 'packages/hrc-server/src/wrkq/session-project-events.ts'],
  ['server-publication-cursor', 'packages/hrc-server/src/wrkq/server-project-events.ts'],
  ['lifecycle-credentials', 'packages/hrc-server/src/index.ts'],
  ['broker-leases-raw-provider-artifacts', 'packages/hrc-server/src/broker/controller.ts'],
  ['spilled-blobs', 'scripts/prune-hrc-event-deltas/spill-tool-results.ts'],
  ['transcript-index', 'packages/hrc-server/src/transcript-index-handlers.ts'],
  ['atomic-release', 'scripts/atomic-install.ts'],
  ['federation-config', 'packages/hrc-server/src/federation/federation-config.ts'],
]) {
  if (!files.includes(path)) {
    continue // Deleted surface on main has no current compatibility obligation.
  }
  add(`file:${id}`, 'durable-file-format', path, undefined, {
    requirement:
      'Path resolution, format/version, writer, atomicity, recovery and consumer compatibility',
  })
}
// Include inspected sources containing no matching registration today.
for (const [path, text] of texts) {
  if (!items.some((i) => i.source.path === path))
    add(`source:${path}`, 'source-coverage-fence', path, undefined, { hash: sha(text) })
}
// Held law/source discrepancies are downstream obligations, not claims that a
// completed historical task shipped the withdrawn backend implementation.
for (const obligation of [
  'materialization-hash',
  'awaiting-occupancy',
  'full-chain-lineage-replay',
]) {
  add(
    `held:mobile-provisioning:${obligation}`,
    'normative-source-gap',
    'architecture/records/invariants/hrc-runtime.mobile-exact-scope-provisioning.yaml',
    undefined,
    {
      gapReason:
        'T-08407 backend amendment was withdrawn (C-22096–98); plugin-only recovery authorization does not establish current Bun support',
      relatedRecord:
        'architecture/records/invariants/hrc-runtime.mobile-suffix-roster-provisioning.yaml',
      requirement: obligation,
      baselineBehaviorClaimed: false,
    }
  )
}
items.sort((a, b) => a.id.localeCompare(b.id))
process.stdout.write(
  `${JSON.stringify(
    {
      schema: 1,
      sourceCommit: commit,
      workingTree,
      items,
      unresolved,
      inventoryComplete: unresolved.length === 0,
      behaviorQualified: false,
    },
    null,
    2
  )}\n`
)
