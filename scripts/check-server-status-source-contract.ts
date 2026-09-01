import { join } from 'node:path'

import ts from 'typescript'

import {
  ACTIVATION_CONTRACT,
  SERVER_STATUS_CONTRACT,
  type ServerStatusContractEntry,
} from '../packages/hrc-cli/src/cli-runtime/server-status-contract.js'

const FORMATTER_PATH = join(
  import.meta.dir,
  '..',
  'packages',
  'hrc-cli',
  'src',
  'cli-runtime',
  'server-status.ts'
)

export const SERVER_STATUS_SOURCE_CONTRACT_EXEMPTIONS = {
  entryFields: ['multiline', 'summarized', 'optional'],
  activationOnlyPaths: ['release.processStartedAt'],
} as const

type ContractPathEntry = Pick<ServerStatusContractEntry, 'label' | 'paths'>

export type ServerStatusSourceContractViolation = {
  label: string
  declaredPaths: string[]
  sourcePaths: string[]
}

type Aliases = Map<string, string>

function unwrap(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrap(expression.expression)
  }
  return expression
}

function resolveMemberPath(expression: ts.Expression, aliases: Aliases): string | undefined {
  const candidate = unwrap(expression)
  if (ts.isIdentifier(candidate)) {
    return aliases.has(candidate.text) ? aliases.get(candidate.text) : undefined
  }
  if (ts.isPropertyAccessExpression(candidate)) {
    const parent = resolveMemberPath(candidate.expression, aliases)
    if (parent === undefined) return undefined
    return parent === '' ? candidate.name.text : `${parent}.${candidate.name.text}`
  }
  if (
    ts.isElementAccessExpression(candidate) &&
    (ts.isStringLiteral(candidate.argumentExpression) ||
      ts.isNumericLiteral(candidate.argumentExpression))
  ) {
    const parent = resolveMemberPath(candidate.expression, aliases)
    if (parent === undefined) return undefined
    return parent === ''
      ? candidate.argumentExpression.text
      : `${parent}.${candidate.argumentExpression.text}`
  }
  return undefined
}

function resolveIterablePath(expression: ts.Expression, aliases: Aliases): string | undefined {
  const candidate = unwrap(expression)
  if (
    ts.isBinaryExpression(candidate) &&
    candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return resolveIterablePath(candidate.left, aliases)
  }
  return resolveMemberPath(candidate, aliases)
}

function collectMemberPaths(node: ts.Node, aliases: Aliases): string[] {
  const paths = new Set<string>()
  const visit = (candidate: ts.Node): void => {
    if (ts.isExpression(candidate)) {
      const path = resolveMemberPath(candidate, aliases)
      if (path !== undefined && path !== '') {
        paths.add(path)
        return
      }
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return [...paths]
}

function lineLabel(expression: ts.Expression): string | undefined {
  const candidate = unwrap(expression)
  const prefix =
    ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)
      ? candidate.text
      : ts.isTemplateExpression(candidate)
        ? candidate.head.text
        : undefined
  return /^ {2}([^ ][^:]*):/.exec(prefix ?? '')?.[1]
}

function pushedExpression(statement: ts.Statement): ts.Expression | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return undefined
  }
  const callee = statement.expression.expression
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'lines' ||
    callee.name.text !== 'push'
  ) {
    return undefined
  }
  return statement.expression.arguments[0]
}

function findFormatter(sourceFile: ts.SourceFile): ts.FunctionDeclaration {
  const formatter = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'formatServerRuntimeStatus'
  )
  if (!formatter?.body) throw new Error('formatServerRuntimeStatus declaration not found')
  return formatter
}

/** Derive each human status label's JSON paths from the formatter's member accesses. */
export function extractServerStatusSourcePaths(source: string): Map<string, string[]> {
  const sourceFile = ts.createSourceFile('server-status.ts', source, ts.ScriptTarget.Latest, true)
  const formatter = findFormatter(sourceFile)
  const pathsByLabel = new Map<string, Set<string>>()

  const record = (
    label: string,
    expression: ts.Expression,
    controls: ts.Expression[],
    scopeAliases: Aliases
  ): void => {
    const directPaths = collectMemberPaths(expression, scopeAliases)
    const paths =
      directPaths.length > 0
        ? directPaths
        : controls.flatMap((control) => collectMemberPaths(control, scopeAliases))
    const labelPaths = pathsByLabel.get(label) ?? new Set<string>()
    for (const path of paths) labelPaths.add(path)
    pathsByLabel.set(label, labelPaths)
  }

  const aliases: Aliases = new Map([['status', '']])

  const processStatement = (
    statement: ts.Statement,
    scopeAliases: Aliases,
    continuationLabel: string | undefined,
    controls: ts.Expression[]
  ): string | undefined => {
    if (ts.isVariableStatement(statement)) {
      let currentLabel = continuationLabel
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isArrayLiteralExpression(declaration.initializer) &&
          declaration.name.text === 'lines'
        ) {
          for (const element of declaration.initializer.elements) {
            if (!ts.isExpression(element)) continue
            const label = lineLabel(element)
            if (!label) continue
            record(label, element, controls, scopeAliases)
            currentLabel = label
          }
          continue
        }
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const path = resolveMemberPath(declaration.initializer, scopeAliases)
          if (path !== undefined) scopeAliases.set(declaration.name.text, path)
        }
      }
      return currentLabel
    }

    const pushed = pushedExpression(statement)
    if (pushed) {
      const label = lineLabel(pushed) ?? continuationLabel
      if (label) record(label, pushed, controls, scopeAliases)
      return lineLabel(pushed) ?? continuationLabel
    }

    if (ts.isBlock(statement)) {
      return processStatements(
        statement.statements,
        new Map(scopeAliases),
        continuationLabel,
        controls
      )
    }

    if (ts.isIfStatement(statement)) {
      const branchControls = [...controls, statement.expression]
      processStatement(
        statement.thenStatement,
        new Map(scopeAliases),
        continuationLabel,
        branchControls
      )
      if (statement.elseStatement) {
        processStatement(
          statement.elseStatement,
          new Map(scopeAliases),
          continuationLabel,
          branchControls
        )
      }
      return continuationLabel
    }

    if (ts.isForOfStatement(statement)) {
      const loopAliases = new Map(scopeAliases)
      const declaration = statement.initializer.declarations[0]
      const iterablePath = resolveIterablePath(statement.expression, scopeAliases)
      if (declaration && ts.isIdentifier(declaration.name) && iterablePath !== undefined) {
        loopAliases.set(declaration.name.text, `${iterablePath}[]`)
      }
      processStatement(statement.statement, loopAliases, continuationLabel, controls)
      return continuationLabel
    }

    return continuationLabel
  }

  const processStatements = (
    statements: ts.NodeArray<ts.Statement>,
    scopeAliases: Aliases,
    continuationLabel: string | undefined,
    controls: ts.Expression[]
  ): string | undefined => {
    let currentLabel = continuationLabel
    for (const statement of statements) {
      currentLabel = processStatement(statement, scopeAliases, currentLabel, controls)
    }
    return currentLabel
  }

  processStatements(formatter.body.statements, aliases, undefined, [])
  return new Map([...pathsByLabel].map(([label, paths]) => [label, [...paths]]))
}

export function findServerStatusSourceContractViolations(
  source: string,
  contract: readonly ContractPathEntry[]
): ServerStatusSourceContractViolation[] {
  const sourcePaths = extractServerStatusSourcePaths(source)
  const contractByLabel = new Map(contract.map((entry) => [entry.label, [...entry.paths]]))
  const labels = new Set([...sourcePaths.keys(), ...contractByLabel.keys()])
  const violations: ServerStatusSourceContractViolation[] = []

  for (const label of labels) {
    const declaredPaths = contractByLabel.get(label) ?? []
    const renderedPaths = sourcePaths.get(label) ?? []
    const declaredSet = new Set(declaredPaths)
    const renderedSet = new Set(renderedPaths)
    if (
      declaredSet.size === renderedSet.size &&
      [...declaredSet].every((path) => renderedSet.has(path))
    ) {
      continue
    }
    violations.push({ label, declaredPaths, sourcePaths: renderedPaths })
  }

  return violations
}

async function main(): Promise<number> {
  const source = await Bun.file(FORMATTER_PATH).text()
  const violations = findServerStatusSourceContractViolations(source, SERVER_STATUS_CONTRACT)
  const renderedPaths = new Set(SERVER_STATUS_CONTRACT.flatMap((entry) => entry.paths))
  const activationOnlyPaths = ACTIVATION_CONTRACT.map((entry) => entry.path).filter(
    (path) => !renderedPaths.has(path)
  )
  const expectedActivationOnlyPaths = [
    ...SERVER_STATUS_SOURCE_CONTRACT_EXEMPTIONS.activationOnlyPaths,
  ]

  if (
    activationOnlyPaths.length !== expectedActivationOnlyPaths.length ||
    activationOnlyPaths.some((path) => !expectedActivationOnlyPaths.includes(path))
  ) {
    console.error(
      `server-status source contract: activation-only paths changed: ${JSON.stringify(activationOnlyPaths)}`
    )
    return 1
  }
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `server-status source contract: ${violation.label}: declared ${JSON.stringify(violation.declaredPaths)}, source reads ${JSON.stringify(violation.sourcePaths)}`
      )
    }
    return 1
  }

  console.log(
    `server-status source contract: ${SERVER_STATUS_CONTRACT.length} labels match formatter accessors ✓`
  )
  return 0
}

if (import.meta.main) process.exit(await main())
