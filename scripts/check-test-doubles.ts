#!/usr/bin/env bun
/**
 * Test doubles are typed against the production interface they stand in for,
 * and a double for a cross-project producer is validated against a captured
 * wire fixture (ruling R2, T-10231).
 *
 * T-10226 found 16 SHAs where a test double agreed with the author's mistake:
 * an untyped object literal can return any shape, so the test passes against a
 * contract the producer never had.
 *
 * WHAT IS A DOUBLE. A declaration in a test source file whose name starts with
 * `fake`, `stub` or `mock` (any case of the first letter) followed by an
 * uppercase letter, digit, `_`, `$` or nothing, or ends in `Double` after a
 * lowercase letter or digit (`tmuxManagerDouble`), and which DEFINES a shape:
 *   - a class declaration,
 *   - a function declaration, or
 *   - a variable whose initializer (through parentheses, `as` and `satisfies`)
 *     is an object literal, arrow function or function expression.
 * A variable initialized any other way (`new FakeX()`, `Bun.serve(...)`, a
 * factory call, a string) is not a double: its type comes from what produced
 * it. A test source file is any tracked `.ts`/`.tsx` under `packages/` or
 * `scripts/` that sits under a `__tests__/` directory or is named `*.test.ts`
 * or `*.fixture.ts`.
 *
 * A function whose declared return type is `void` or `Promise<void>` installs a
 * double (a spy, a module mock) rather than being one, and is not a double.
 *
 * TYPED. A class has an `implements` clause; a function (declaration, arrow or
 * expression) has a return type annotation; an object literal has a variable
 * type annotation or ends in `satisfies T`. `as T` is a cast and does not
 * count. The type must name at least one identifier IMPORTED FROM PRODUCTION:
 * a package specifier, or a relative path that is not itself a test source. A
 * type declared in test code is the double describing itself and does not
 * count, nor does a type that checks nothing (`any`, `unknown`, `object`,
 * `{}`, `Function`, `Record<K, any|unknown>`).
 *
 * CONFORMING. A typed double conforms when no type error starts inside its
 * declaration. Package tsconfigs exclude `*.test.ts`, so the check type-checks
 * the files that declare typed doubles itself (see typeErrorsIn); without that
 * a `satisfies` in a test file would never be checked.
 *
 * Nonconforming doubles (untyped, or typed with an error inside) are ratcheted
 * per file in BASELINE_PATH (`nonconforming`): a file above its count fails,
 * and a file below it fails until the baseline is lowered with
 * `--update-baseline` (which never raises an entry).
 *
 * CROSS-PROJECT PRODUCERS. A double is a producer double when its declared
 * type names an identifier imported from a module in PRODUCER_MODULES (the
 * wrkq ledger, aspd, ghostmux). A producer double carries a `@captured <path>`
 * tag in its leading comment, naming a fixture under
 * `__tests__/fixtures/captured/` that exists, records the producer and its
 * version (see docs/test-doubles.md), and is referenced from a test file in
 * the same package. Producer doubles that predate the rule are listed by a
 * hash of their text in BASELINE_PATH (`uncaptured`); adding one, or changing
 * a listed one, requires the capture. No big-bang recapture.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import ts from 'typescript'

export const BASELINE_PATH = 'scripts/test-double-baseline.json'
export const CAPTURED_DIR = '__tests__/fixtures/captured/'

export type Producer = 'wrkq' | 'aspd' | 'ghostmux'

/**
 * Module specifiers (bare packages, matched with any subpath) and repo paths
 * (relative imports, resolved) whose exported types are a cross-project
 * producer's wire contract.
 */
export const PRODUCER_MODULES: ReadonlyArray<{ producer: Producer; module: string }> = [
  { producer: 'wrkq', module: 'packages/hrc-server/src/wrkq/ledger-client.ts' },
  { producer: 'aspd', module: 'spaces-aspc-protocol' },
  // HRC has no ghostmux client module today; the first one is covered on import.
  { producer: 'ghostmux', module: 'ghostmux' },
]

const DOUBLE_NAME = /^(fake|stub|mock|Fake|Stub|Mock)([A-Z0-9_$]|$)|[a-z0-9]Double$/

export type Double = {
  name: string
  line: number
  typed: boolean
  producer?: Producer | undefined
  captured?: string | undefined
  /** sha256 of the declaration text with whitespace collapsed, 12 hex chars. */
  hash: string
  /** Character span of the declaration, for locating type errors inside it. */
  start: number
  end: number
}

export type Baseline = {
  nonconforming: Record<string, number>
  uncaptured: Record<string, string[]>
}

export type Violation = { path: string; message: string }

export function isTestSource(path: string): boolean {
  if (!/^(packages|scripts)\/.+\.tsx?$/.test(path) || path.endsWith('.d.ts')) return false
  return /(^|\/)__tests__\//.test(path) || /\.(test|fixture)\.tsx?$/.test(path)
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** The outermost `satisfies T` around an initializer, through parentheses and casts. */
function satisfiesType(node: ts.Expression): ts.TypeNode | undefined {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
    current = current.expression
  }
  return ts.isSatisfiesExpression(current) ? current.type : undefined
}

/** A type annotation that type-checks nothing. */
export function isVacuousType(type: ts.TypeNode): boolean {
  if (
    type.kind === ts.SyntaxKind.AnyKeyword ||
    type.kind === ts.SyntaxKind.UnknownKeyword ||
    type.kind === ts.SyntaxKind.ObjectKeyword
  ) {
    return true
  }
  if (ts.isTypeLiteralNode(type) && type.members.length === 0) return true
  if (ts.isParenthesizedTypeNode(type)) return isVacuousType(type.type)
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText()
    if (name === 'Function') return true
    if (name === 'Record') {
      const value = type.typeArguments?.[1]
      return value !== undefined && isVacuousType(value)
    }
  }
  return false
}

/** Identifiers a type expression names, e.g. `Partial<WrkqLedgerClient>` → both. */
function typeIdentifiers(node: ts.Node): string[] {
  const names: string[] = []
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      const name = child.typeName
      names.push(ts.isIdentifier(name) ? name.text : name.left.getText())
    } else if (ts.isExpressionWithTypeArguments(child)) {
      names.push(child.expression.getText().split('.')[0] ?? '')
    } else if (ts.isTypeQueryNode(child)) {
      names.push(child.exprName.getText().split('.')[0] ?? '')
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return names
}

export function producerOfSpecifier(specifier: string, importer: string): Producer | undefined {
  const resolved = specifier.startsWith('.')
    ? normalize(join(dirname(importer), specifier)).replace(/\.(js|ts)$/, '')
    : specifier
  for (const { producer, module } of PRODUCER_MODULES) {
    if (module.startsWith('packages/')) {
      if (resolved === module.replace(/\.ts$/, '')) return producer
    } else if (resolved === module || resolved.startsWith(`${module}/`)) {
      return producer
    }
  }
  return undefined
}

type ImportedType = { production: boolean; producer?: Producer | undefined }

/**
 * Whether an import specifier names production code: a package, or a relative
 * path that does not resolve to a test source.
 */
export function isProductionSpecifier(specifier: string, importer: string): boolean {
  if (!specifier.startsWith('.')) return true
  const resolved = normalize(join(dirname(importer), specifier)).replace(/\.(js|ts|tsx)$/, '')
  return !isTestSource(`${resolved}.ts`)
}

/** Local identifier → where it was imported from. */
function importedTypes(file: ts.SourceFile, path: string): Map<string, ImportedType> {
  const imports = new Map<string, ImportedType>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const specifier = statement.moduleSpecifier.text
    const origin: ImportedType = {
      production: isProductionSpecifier(specifier, path),
      producer: producerOfSpecifier(specifier, path),
    }
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) imports.set(clause.name.text, origin)
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, origin)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) imports.set(element.name.text, origin)
    }
  }
  return imports
}

/** `void` or `Promise<void>`: the function installs a double rather than being one. */
function returnsVoid(type: ts.TypeNode | undefined): boolean {
  if (!type) return false
  if (type.kind === ts.SyntaxKind.VoidKeyword) return true
  return (
    ts.isTypeReferenceNode(type) &&
    type.typeName.getText() === 'Promise' &&
    type.typeArguments?.[0]?.kind === ts.SyntaxKind.VoidKeyword
  )
}

function capturedTag(node: ts.Node, source: string): string | undefined {
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []
  for (const range of ranges) {
    const match = /@captured\s+(\S+)/.exec(source.slice(range.pos, range.end))
    if (match) return match[1]
  }
  return undefined
}

function hashOf(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12)
}

export function findDoubles(path: string, source: string): Double[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports = importedTypes(file, path)
  const doubles: Double[] = []

  const record = (
    name: string,
    node: ts.Node,
    commentAnchor: ts.Node,
    types: ReadonlyArray<ts.Node>
  ): void => {
    const named = types
      .filter((type) => !ts.isTypeNode(type) || !isVacuousType(type))
      .flatMap((type) => typeIdentifiers(type))
      .map((identifier) => imports.get(identifier))
      .filter(isPresent)
    const producer = named.find((origin) => origin.producer)?.producer
    doubles.push({
      name,
      line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      typed: named.some((origin) => origin.production),
      producer,
      captured: capturedTag(commentAnchor, source),
      hash: hashOf(node.getText()),
      start: node.getStart(),
      end: node.getEnd(),
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name && DOUBLE_NAME.test(node.name.text)) {
      const implemented = (node.heritageClauses ?? [])
        .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
        .flatMap((clause) => [...clause.types])
      record(node.name.text, node, node, implemented)
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      DOUBLE_NAME.test(node.name.text) &&
      !returnsVoid(node.type)
    ) {
      record(node.name.text, node, node, node.type ? [node.type] : [])
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      DOUBLE_NAME.test(node.name.text) &&
      node.initializer
    ) {
      const value = unwrap(node.initializer)
      const statement = node.parent.parent
      if (ts.isObjectLiteralExpression(value)) {
        const satisfied = satisfiesType(node.initializer)
        record(node.name.text, node, statement, [node.type, satisfied].filter(isPresent))
      } else if (
        (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) &&
        !returnsVoid(node.type ?? value.type)
      ) {
        record(node.name.text, node, statement, [node.type, value.type].filter(isPresent))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return doubles
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

export type CapturedFixture = { path: string; text: string | undefined }

/**
 * Why a cited capture does not validate a producer double, or undefined when
 * it does. `packageTests` is the concatenated source of the package's test
 * files; the fixture's file name must appear in it outside a `@captured` tag.
 */
export function capturedFixtureProblem(
  producer: Producer,
  fixture: CapturedFixture,
  packageTests: string
): string | undefined {
  if (!fixture.path.includes(CAPTURED_DIR)) {
    return `${fixture.path} is not under ${CAPTURED_DIR}`
  }
  if (fixture.text === undefined) return `${fixture.path} does not exist`
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fixture.text) as Record<string, unknown>
  } catch {
    return `${fixture.path} is not JSON`
  }
  if (parsed['producer'] !== producer) {
    return `${fixture.path} records producer ${JSON.stringify(parsed['producer'])}, expected "${producer}"`
  }
  for (const key of ['producerVersion', 'capturedAt', 'request'] as const) {
    if (typeof parsed[key] !== 'string' || (parsed[key] as string).length === 0) {
      return `${fixture.path} has no "${key}" string`
    }
  }
  if (!('response' in parsed)) return `${fixture.path} has no "response"`
  const base = fixture.path.split('/').pop() ?? ''
  const referenced = packageTests.replace(/@captured\s+\S+/g, '').includes(base)
  if (!referenced) return `no test in the package reads ${base}; validate the double against it`
  return undefined
}

export type TestSource = { path: string; source: string }

export function packageOf(path: string): string {
  const match = /^packages\/([^/]+)\//.exec(path)
  return match ? `packages/${match[1]}` : 'scripts'
}

/** A type error: where it starts in its file, and what it says. */
export type TypeError = { start: number; message: string }

export function findDoubleViolations(
  files: ReadonlyArray<TestSource>,
  baseline: Baseline,
  readFixture: (path: string) => string | undefined,
  typeErrors: ReadonlyMap<string, readonly TypeError[]>
): { violations: Violation[]; observed: Baseline } {
  const violations: Violation[] = []
  const observed: Baseline = { nonconforming: {}, uncaptured: {} }
  const testsByPackage = new Map<string, string>()
  for (const { path, source } of files) {
    const key = packageOf(path)
    testsByPackage.set(key, `${testsByPackage.get(key) ?? ''}\n${source}`)
  }

  for (const { path, source } of files) {
    const doubles = findDoubles(path, source)
    const errors = typeErrors.get(path) ?? []
    const nonconforming = doubles
      .map((double) => ({
        double,
        reason: double.typed
          ? errors.find((error) => error.start >= double.start && error.start < double.end)?.message
          : 'not typed against a production type',
      }))
      .filter((entry) => entry.reason !== undefined)
    if (nonconforming.length > 0) observed.nonconforming[path] = nonconforming.length
    const allowed = baseline.nonconforming[path] ?? 0
    if (nonconforming.length > allowed) {
      const names = nonconforming
        .map(({ double, reason }) => `${double.name}:${double.line} ${reason}`)
        .join('; ')
      violations.push({
        path,
        message: `${nonconforming.length} nonconforming double(s), baseline ${allowed} (${names}); declare each with \`satisfies <ProductionInterface>\`, a type annotation, or \`implements\`, and make it type-check`,
      })
    } else if (nonconforming.length < allowed) {
      violations.push({
        path,
        message: `${nonconforming.length} nonconforming double(s), below baseline ${allowed}; lower it with \`bun scripts/check-test-doubles.ts --update-baseline\``,
      })
    }

    const legacy = [...(baseline.uncaptured[path] ?? [])]
    for (const double of doubles) {
      if (!double.producer) continue
      const id = `${double.name}:${double.hash}`
      if (double.captured) {
        const fixturePath = normalize(join(dirname(path), double.captured))
        const problem = capturedFixtureProblem(
          double.producer,
          { path: fixturePath, text: readFixture(fixturePath) },
          testsByPackage.get(packageOf(path)) ?? ''
        )
        if (problem) violations.push({ path, message: `${double.name}:${double.line}: ${problem}` })
        continue
      }
      const index = legacy.indexOf(id)
      if (index >= 0) {
        legacy.splice(index, 1)
        observed.uncaptured[path] = [...(observed.uncaptured[path] ?? []), id]
        continue
      }
      violations.push({
        path,
        message: `${double.name}:${double.line} is a new or changed ${double.producer} double without a captured fixture; capture one real ${double.producer} response under ${CAPTURED_DIR} and tag the double \`@captured <path>\` (docs/test-doubles.md)`,
      })
    }
    for (const stale of legacy) {
      violations.push({
        path,
        message: `baseline lists uncaptured double ${stale} that is no longer present; drop it with \`bun scripts/check-test-doubles.ts --update-baseline\``,
      })
    }
  }

  const seen = new Set(files.map((file) => file.path))
  for (const path of Object.keys(baseline.nonconforming)) {
    if (!seen.has(path)) {
      violations.push({ path, message: 'baseline names a file that no longer exists' })
    }
  }
  for (const path of Object.keys(baseline.uncaptured)) {
    if (!seen.has(path)) {
      violations.push({ path, message: 'baseline names a file that no longer exists' })
    }
  }
  return { violations, observed }
}

/**
 * The baseline after removing what was fixed. Refuses to raise a nonconforming
 * count or add an uncaptured entry: the baseline only goes down.
 */
export function lowerBaseline(baseline: Baseline, observed: Baseline): Baseline | string {
  const nonconforming: Record<string, number> = {}
  for (const [path, count] of Object.entries(observed.nonconforming)) {
    if (count > (baseline.nonconforming[path] ?? 0)) {
      return `${path} has ${count} nonconforming double(s), above baseline ${baseline.nonconforming[path] ?? 0}; fix the new double instead`
    }
    nonconforming[path] = count
  }
  return { nonconforming: sortKeys(nonconforming), uncaptured: sortKeys(observed.uncaptured) }
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Type errors in the files that declare doubles, grouped by package so each is
 * checked under its own tsconfig. Package tsconfigs exclude `*.test.ts`, so
 * without this a `satisfies` in a test file is never checked. Only the files
 * holding doubles are roots; an error counts only when it starts inside a
 * double, so the existing errors elsewhere in test code do not.
 */
export function typeErrorsIn(repoRoot: string, paths: readonly string[]): Map<string, TypeError[]> {
  const byConfig = new Map<string, string[]>()
  for (const path of paths) {
    const pkg = packageOf(path)
    const config = pkg === 'scripts' ? 'tsconfig.json' : `${pkg}/tsconfig.json`
    byConfig.set(config, [...(byConfig.get(config) ?? []), path])
  }
  const errors = new Map<string, TypeError[]>()
  for (const [config, roots] of byConfig) {
    const configPath = join(repoRoot, config)
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        },
      }
    )
    if (!parsed) throw new Error(`check-test-doubles: cannot read ${config}`)
    const program = ts.createProgram({
      rootNames: roots.map((path) => join(repoRoot, path)),
      options: {
        ...parsed.options,
        noEmit: true,
        incremental: false,
        composite: false,
        declaration: false,
        declarationMap: false,
        tsBuildInfoFile: undefined,
      },
    })
    for (const path of roots) {
      const file = program.getSourceFile(join(repoRoot, path))
      if (!file) continue
      const diagnostics = [
        ...program.getSyntacticDiagnostics(file),
        ...program.getSemanticDiagnostics(file),
      ]
      errors.set(
        path,
        diagnostics.map((diagnostic) => ({
          start: diagnostic.start ?? 0,
          message: `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
        }))
      )
    }
  }
  return errors
}

function main(): void {
  const repoRoot = dirname(import.meta.dir)
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', 'packages', 'scripts'], {
    cwd: repoRoot,
    stdout: 'pipe',
  })
  if (listed.exitCode !== 0) {
    console.error('check-test-doubles: git ls-files failed')
    process.exit(1)
  }
  const files = listed.stdout
    .toString()
    .split('\0')
    .filter((path) => path && isTestSource(path) && existsSync(join(repoRoot, path)))
    .map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }))
  const baselineFile = join(repoRoot, BASELINE_PATH)
  const baseline = (
    existsSync(baselineFile)
      ? JSON.parse(readFileSync(baselineFile, 'utf8'))
      : { nonconforming: {}, uncaptured: {} }
  ) as Baseline
  const readFixture = (path: string): string | undefined => {
    const absolute = join(repoRoot, path)
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
  }
  const withDoubles = files
    .filter(({ path, source }) => findDoubles(path, source).some((double) => double.typed))
    .map(({ path }) => path)
  const typeErrors = typeErrorsIn(repoRoot, withDoubles)
  const { violations, observed } = findDoubleViolations(files, baseline, readFixture, typeErrors)

  if (process.argv.includes('--update-baseline')) {
    const lowered = lowerBaseline(baseline, observed)
    if (typeof lowered === 'string') {
      console.error(`check-test-doubles: refusing to raise the baseline: ${lowered}`)
      process.exit(1)
    }
    writeFileSync(baselineFile, `${JSON.stringify(lowered, null, 2)}\n`)
    console.log(`check-test-doubles: wrote ${BASELINE_PATH}`)
    return
  }

  if (violations.length > 0) {
    console.error('check-test-doubles: test doubles not typed against production:')
    for (const violation of violations) console.error(`  ${violation.path}: ${violation.message}`)
    process.exit(1)
  }
  const nonconforming = Object.values(observed.nonconforming).reduce((sum, n) => sum + n, 0)
  const uncaptured = Object.values(observed.uncaptured).reduce((sum, ids) => sum + ids.length, 0)
  console.log(
    `check-test-doubles: no new nonconforming or uncaptured double (baseline: ${nonconforming} nonconforming in ${Object.keys(observed.nonconforming).length} files, ${uncaptured} uncaptured producer double(s))`
  )
}

if (import.meta.main) main()
