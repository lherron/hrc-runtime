import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import ts from 'typescript'

/** The delivery functions, rather than their server-registration tables. */
export const ADMISSION_EXECUTORS = new Set([
  'executeAdmittedTurn',
  'executeSemanticTurn',
  'dispatchPublicSubmission',
  'executeHeadlessBrokerStartTurn',
  'dispatchQueuedHeadlessTurnInput',
  'dispatchIntoProducerSelectedTmuxRuntime',
  'deliverIntoAttachedParticipant',
  'handleHeadlessDispatchTurn',
  'handleHeadlessBrokerDispatchTurn',
  'handleInteractiveTmuxBrokerDispatchTurn',
  'executeInteractiveBrokerInputTurn',
  'executeHeadlessBrokerInputTurn',
  'executeHeadlessBrokerFormat2DispatchTurn',
  'tryDeliverSemanticTurnToInteractiveRuntime',
  'executeBrokerInputTurn',
  'deliverAttachedRunPrompt',
])
const protectedImports = new Set([
  ...ADMISSION_EXECUTORS,
  'createAdmittedPlan',
  'admissionRouteMethods',
])
const legacy = new Set(['dispatchTurnForSession', 'dispatchAdmittedTurnForSession'])

export async function checkAdmissionEntry(root: string) {
  const sourceRoot = join(root, 'packages/hrc-server/src')
  const files: string[] = []
  const violations: string[] = []
  async function collect(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (entry.name.endsWith('.ts') && !/\.(test|fixture)\.ts$/.test(entry.name))
        files.push(path)
    }
  }
  await collect(sourceRoot)
  if (files.length === 0) violations.push('No production HRC source files found')
  const parses = await Promise.all(
    files.map(async (file) => ({
      file,
      ast: ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true),
    }))
  )
  const executorModules = new Set<string>()
  for (const { file, ast } of parses) {
    function visit(node: ts.Node) {
      if (
        (ts.isFunctionDeclaration(node) && node.name && protectedImports.has(node.name.text)) ||
        (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'admissionRouteMethods')
      )
        executorModules.add(file.replace(/\.ts$/, ''))
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  for (const { file, ast } of parses) {
    const path = relative(sourceRoot, file)
    const internal = path.startsWith('turn-admission/')
    const report = (node: ts.Node, reason: string) =>
      violations.push(
        `${path}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${reason}`
      )
    function checkExecutorImports(node: ts.Node) {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        if (node.importClause?.name && ts.isStringLiteral(node.moduleSpecifier)) {
          const target = join(file, '..', node.moduleSpecifier.text).replace(/\.(?:js|ts)$/, '')
          if (executorModules.has(target))
            report(node, 'Executor default import outside turn-admission')
        }
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings))
          for (const item of bindings.elements) {
            const name = (item.propertyName ?? item.name).text
            const bootstrap = name === 'admissionRouteMethods' && path === 'index.ts'
            if (!item.isTypeOnly && protectedImports.has(name) && !bootstrap)
              report(item, 'Executor import outside turn-admission')
          }
        else if (
          bindings &&
          ts.isNamespaceImport(bindings) &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const target = join(file, '..', node.moduleSpecifier.text).replace(/\.(?:js|ts)$/, '')
          if (executorModules.has(target))
            report(node, 'Executor namespace import outside turn-admission')
        }
      }
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      )
        for (const item of node.exportClause.elements) {
          if (!item.isTypeOnly && protectedImports.has((item.propertyName ?? item.name).text))
            report(item, 'Executor re-export outside turn-admission')
        }
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        (!node.exportClause || ts.isNamespaceExport(node.exportClause)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = join(file, '..', node.moduleSpecifier.text).replace(/\.(?:js|ts)$/, '')
        if (executorModules.has(target))
          report(node, 'Executor wildcard re-export outside turn-admission')
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const target = join(file, '..', node.arguments[0].text).replace(/\.(?:js|ts)$/, '')
        if (executorModules.has(target))
          report(node, 'Dynamic executor import outside turn-admission')
      }
    }
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && ADMISSION_EXECUTORS.has(node.name.text)) {
        const first = node.parameters.find((param) => param.name.getText(ast) !== 'this')
        if (!first || first.questionToken || first.type?.getText(ast) !== 'AdmittedPlan')
          report(node, `${node.name.text} must take a required AdmittedPlan first`)
      }
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && legacy.has(node.text))
        report(node, 'Legacy dispatch entry is sealed')
      if (!internal) {
        if (
          (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
          /\bAdmittedPlan\b/.test(node.type.getText(ast))
        )
          report(node, 'Only turn-admission may construct a branded plan')
        checkExecutorImports(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return { files: files.length, violations }
}

if (import.meta.main) {
  const result = await checkAdmissionEntry(process.cwd())
  if (result.violations.length) {
    console.error(result.violations.join('\n'))
    process.exitCode = 1
  } else console.log(`admission-entry: ${result.files} production files sealed`)
}
