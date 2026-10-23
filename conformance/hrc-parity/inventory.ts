import { execFileSync } from 'node:child_process'
/** Source discovery only. Does not construct a daemon or parse a CLI action. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildProgram } from '../../packages/hrc-cli/src/cli/build-program.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const index = process.argv.indexOf('--source-ref')
const ref = index < 0 ? 'HEAD' : process.argv[index + 1]
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
const commit = git('rev-parse', ref).trim()
const files = git('ls-tree', '-r', '--name-only', commit).trim().split('\n')
const texts = new Map<string, string>()
const asts = new Map<string, ts.SourceFile>()
const unresolved: string[] = []
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
function source(path: string): ts.SourceFile {
  const old = asts.get(path)
  if (old) return old
  const text = git('show', `${commit}:${path}`)
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
  caseIds: string[]
  downstreamOwner: string
  coverage: 'GAP'
  gapReason: string
  [key: string]: unknown
}
const items: Item[] = []
function owner(path: string): string {
  if (/federation|placement|ingest|forward/.test(path)) return 'T-11532'
  if (/messages|subscribers|\/events|mail\//.test(path)) return 'T-11531'
  if (/transcript|diagnostic|presentation|health|status|preview/.test(path)) return 'T-11533'
  if (/participant|registration|resolve|runtimes\/(start|ensure)/.test(path)) return 'T-11529'
  return 'T-11530'
}
function add(
  id: string,
  kind: string,
  path: string,
  node: ts.Node | undefined,
  downstreamOwner: string,
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
    caseIds: [id],
    downstreamOwner,
    coverage: 'GAP',
    gapReason: 'Behavior not yet qualified; source discovery is not a behavioral pass',
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
  add(`public:${method}:${path}`, 'public-exact', routeSource, n, owner(path), {
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
  add(`public:${method}:${path}`, 'public-computed', computed, n, owner(path), {
    path,
    method,
    transport: 'public-unix',
  })
})
// Dynamic matchers deliberately have an explicit semantic overlay. Their complete
// bytes are fenced below: matcher edits cannot be silently accepted as new coverage.
const patterns: [string, string, string][] = [
  ['GET', '/v1/inputs/:inputId', 'input-handlers.ts'],
  ['GET', '/v1/inputs/:inputId/watch', 'input-handlers.ts'],
  ['GET', '/v1/sessions/by-host/:hostSessionId', 'server-request-methods.ts'],
  ['POST', '/v1/sessions/:hostSessionId/title', 'server-routing.ts'],
  ['DELETE', '/v1/sessions/:hostSessionId/title', 'server-routing.ts'],
  ['GET', '/v1/runtimes/:runtimeId/seat', 'server-routing.ts'],
  ['GET', '/v1/active-run-contributions/:inputApplicationId', 'server-request-methods.ts'],
  ...['continuation', 'wrapper-started', 'child-started', 'event', 'exited'].map(
    (suffix): [string, string, string] => [
      'POST',
      `/v1/internal/launches/:launchId/${suffix}`,
      'server-routing.ts',
    ]
  ),
]
for (const [method, path, file] of patterns)
  add(
    `public:${method}:${path}`,
    'public-pattern',
    `packages/hrc-server/src/${file}`,
    undefined,
    'T-11530',
    { method, path, transport: 'public-unix', retired: path.includes('/internal/launches/') }
  )
for (const file of ['server-request-methods.ts', 'server-routing.ts', 'input-handlers.ts']) {
  add(
    `dispatch-source:${file}`,
    'dispatch-source-fence',
    `packages/hrc-server/src/${file}`,
    undefined,
    'T-11530',
    { requirement: 'Any hash drift requires explicit matcher/guard review' }
  )
}
for (const [listener, path] of [
  ['peer', 'packages/hrc-server/src/federation/peer-protocol.ts'],
  ['registry', 'packages/hrc-server/src/federation/registry-endpoint.ts'],
  ['ingest', 'packages/hrc-server/src/event-ingest.ts'],
]) {
  const discovered = new Map<string, ts.Node>()
  walk(source(path), (n) => {
    const s = string(n)
    if (s?.startsWith('/v1/')) discovered.set(s, n)
  })
  const methods: Record<string, string[]> = {
    '/v1/sessions/metadata': ['GET', 'PATCH'],
    '/v1/sessions/get': ['GET'],
    '/v1/sessions/page': ['GET'],
    '/v1/sessions/facets': ['GET'],
    '/v1/events/tail': ['GET'],
    '/v1/events/bounded-stream': ['GET'],
    '/v1/runs': ['GET'],
    '/v1/federation/health': ['GET'],
    '/v1/federation/registry/designation': ['GET'],
    '/v1/federation/registry/unborn-designations': ['GET'],
    '/v1/federation/registry/consult': ['GET'],
  }
  for (const [route, node] of discovered) {
    if (route.endsWith('/')) {
      add(
        `${listener}:dispatch-prefix:${route}`,
        'listener-dispatch-prefix',
        path,
        node,
        'T-11532',
        { path: route, requirement: 'Dispatch-prefix behavior and unknown suffix refusals' }
      )
      continue
    }
    const postRoutes = new Set([
      '/v1/ingest',
      '/v1/sessions/resolve',
      '/v1/federation/establish',
      '/v1/federation/exact-start',
      '/v1/federation/roster-start',
      '/v1/federation/locate',
      '/v1/federation/history/checkpoint',
      '/v1/federation/history/query',
      '/v1/federation/history/replicate',
      '/v1/federation/server-lifecycle',
      '/v1/federation/registry/delete',
      '/v1/federation/registry/designate-birth',
      '/v1/federation/registry/establish',
    ])
    if (!methods[route] && !postRoutes.has(route)) {
      unresolved.push(`Unknown auxiliary route method/guard: ${listener} ${route}`)
      continue
    }
    for (const method of methods[route] ?? ['POST'])
      add(`${listener}:${method}:${route}`, 'auxiliary-route', path, node, 'T-11532', {
        method,
        path: route,
        transport: listener,
        variants: ['authenticated-positive', 'wrong-token', 'wrong-method', 'malformed', 'effects'],
      })
  }
  add(`${listener}:dispatch-source`, 'dispatch-source-fence', path, undefined, 'T-11532')
}
// Capture the actual Commander graph, including ancestry, aliases, argument and
// option declarations. Never call parse/parseAsync or any command handler.
for (const path of files.filter(
  (p) => p.startsWith('packages/hrc-cli/src/') && p.endsWith('.ts') && !p.includes('/__tests__/')
)) {
  if (
    readFileSync(`${root}/${path}`, 'utf8') !== texts.get(path) &&
    readFileSync(`${root}/${path}`, 'utf8') !== git('show', `${commit}:${path}`)
  ) {
    unresolved.push(`CLI introspection does not match source-ref: ${path}`)
  }
}
function commandTree(command: ReturnType<typeof buildProgram>, parents: string[]) {
  const ancestry = [...parents, command.name()]
  const path = 'packages/hrc-cli/src/cli/build-program.ts'
  add(`cli:${ancestry.join(' ')}`, 'cli-command', path, undefined, 'T-11534', {
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
    add(`cli-alias:${[...parents, alias].join(' ')}`, 'cli-alias', path, undefined, 'T-11534', {
      aliasOf: `cli:${ancestry.join(' ')}`,
    })
  for (const child of command.commands) commandTree(child, ancestry)
}
commandTree(buildProgram(), [])
for (const path of files) {
  if (path.startsWith('packages/') && path.endsWith('/package.json')) {
    const pkg = JSON.parse(git('show', `${commit}:${path}`))
    for (const [key, value] of Object.entries(pkg.exports ?? {}))
      add(`export:${pkg.name}:${key}`, 'package-export', path, undefined, 'T-11533', {
        conditions: value,
      })
    for (const [key, value] of Object.entries(pkg.bin ?? {}))
      add(`bin:${key}`, 'package-bin', path, undefined, 'T-11534', { entry: value })
  }
  if (!path.endsWith('.ts') || path.includes('/__tests__/')) continue
  if (path.startsWith('packages/hrc-store-sqlite/src/')) {
    const ast = source(path)
    add(`store-source:${path}`, 'store-source', path, undefined, 'T-11528')
    walk(ast, (n) => {
      if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) {
        const symbol = name(n.name)
        if (symbol)
          add(
            `store-op:${path}:${enclosing(n)}:${symbol}:${n.getStart(ast)}`,
            'store-operation',
            path,
            n,
            'T-11528',
            { operation: symbol, declaration: n.getText(ast).split('{')[0] }
          )
      }
      if (
        ts.isStringLiteralLike(n) &&
        /CREATE\s+(TABLE|INDEX|TRIGGER|VIRTUAL)|ALTER\s+TABLE/i.test(n.text)
      ) {
        add(`schema-sql:${path}:${n.getStart(ast)}`, 'schema-sql', path, n, 'T-11528', {
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
        add(`timer:${path}:${n.getStart(ast)}`, 'job-timer', path, n, owner(path), {
          callee,
          cadence: n.arguments[1]?.getText(ast) ?? 'unspecified',
          requirement: 'Startup/trigger, one executor, recovery, shutdown and durable effects',
        })
      if (
        path.endsWith('/index.ts') &&
        /\b(start[A-Z]|warmDurable|scheduleExternal|recoverCold)/.test(callee)
      ) {
        add(`startup:${path}:${n.getStart(ast)}:${n.end}`, 'startup-job', path, n, owner(callee), {
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
      add(`direct:${path}:${n.getStart(ast)}`, 'direct-store-call', path, n, 'T-11534', {
        expression: n.expression.getText(ast),
        requirement:
          'Resolve exact DB, SQL columns, reader/writer effects and valid nonempty subject',
      })
    }
    if (ts.isNewExpression(n) && name(n.expression) === 'Database')
      add(`direct-open:${path}:${n.getStart(ast)}`, 'direct-store-open', path, n, 'T-11534', {
        arguments: n.arguments?.map((a) => a.getText(ast)),
      })
  })
}
// File recovery overlay: each is an explicit format and lifecycle obligation.
for (const [id, path, task] of [
  ['state-wal-shm', 'packages/hrc-store-sqlite/src/database.ts', 'T-11528'],
  ['registry-db', 'packages/hrc-server/src/federation/registry-endpoint.ts', 'T-11532'],
  ['ingest-spool-forward-cursors', 'packages/hrc-server/src/event-ingest.ts', 'T-11532'],
  [
    'session-publication-cursor',
    'packages/hrc-server/src/wrkq/session-project-events.ts',
    'T-11531',
  ],
  ['server-publication-cursor', 'packages/hrc-server/src/wrkq/server-project-events.ts', 'T-11531'],
  ['lifecycle-credentials', 'packages/hrc-server/src/index.ts', 'T-11529'],
  ['registration-grants', 'packages/hrc-server/src/external-registration-rendezvous.ts', 'T-11529'],
  [
    'broker-leases-raw-provider-artifacts',
    'packages/hrc-server/src/broker/controller.ts',
    'T-11530',
  ],
  ['spilled-blobs', 'scripts/prune-hrc-event-deltas/spill-tool-results.ts', 'T-11534'],
  ['transcript-index', 'packages/hrc-server/src/transcript-index-handlers.ts', 'T-11533'],
  ['atomic-release', 'scripts/atomic-install.ts', 'T-11533'],
  ['federation-config', 'packages/hrc-server/src/federation/federation-config.ts', 'T-11532'],
]) {
  if (!files.includes(path)) {
    unresolved.push(`Missing file overlay source: ${path}`)
    continue
  }
  add(`file:${id}`, 'durable-file-format', path, undefined, task, {
    requirement:
      'Path resolution, format/version, writer, atomicity, recovery and consumer compatibility',
  })
}
// Every inspected source is fenced, including CLI registrations imported by its
// builder, SQL/DDL helpers and code containing no matching literal today.
for (const [path, text] of texts) {
  if (!items.some((i) => i.source.path === path))
    add(
      `source:${path}`,
      'source-coverage-fence',
      path,
      undefined,
      path.includes('store-sqlite') ? 'T-11528' : owner(path),
      { hash: sha(text) }
    )
}
// The real initialized Bun store supplied this frozen schema after the first
// real observation. The runner independently compares it to each admitted DB.
const schema = JSON.parse(readFileSync(`${root}/contract/hrc-parity/store-schema.json`, 'utf8'))
const schemaSource = 'packages/hrc-store-sqlite/src/database.ts'
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
    'T-11529',
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
for (const table of schema.tables) {
  add(`schema:table:${table.name}`, 'store-table', schemaSource, undefined, 'T-11528', {
    table: table.name,
    columns: table.columns,
    foreignKeys: table.foreignKeys,
    indexes: table.indexes,
    observedSchemaHash: sha(JSON.stringify(table)),
  })
}
for (const object of schema.objects) {
  if (object.type === 'table') continue
  add(
    `schema:${object.type}:${object.name}`,
    `store-${object.type}`,
    schemaSource,
    undefined,
    'T-11528',
    {
      ...object,
      observedSchemaHash: sha(JSON.stringify(object)),
    }
  )
}
for (const item of items) {
  if (item.id === 'public:POST:/v1/bridges/local-target')
    item.aliasOf = 'public:POST:/v1/bridges/target'
}
items.sort((a, b) => a.id.localeCompare(b.id))
process.stdout.write(
  `${JSON.stringify(
    {
      schema: 1,
      sourceCommit: commit,
      items,
      unresolved,
      inventoryComplete: unresolved.length === 0,
      behaviorQualified: false,
    },
    null,
    2
  )}\n`
)
