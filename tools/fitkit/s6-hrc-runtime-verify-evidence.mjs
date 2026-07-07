import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PREDICATE_ID = 'fit:s6/hrc-runtime-lefthook-verify-closure'

const VERIFY_LEAF_ORDER = [
  'check:boundaries',
  'check:cli-surface',
  'check:manifests',
  'check:public-surface',
  'check:suppressions',
  'lint',
  'test',
  'typecheck',
]

const CHECK_COMMAND_LABELS = [
  [/check-boundaries\.ts\b/, 'check:boundaries'],
  [/check-cli-surface\.ts\b/, 'check:cli-surface'],
  [/check-manifest-edges\.ts\b/, 'check:manifests'],
  [/check-public-surface\.ts\b/, 'check:public-surface'],
  [/check-suppressions\.ts\b/, 'check:suppressions'],
]

const HOOK_COVERAGE = {
  'check:boundaries': /check-boundaries\.ts\b/,
  'check:cli-surface': /check-cli-surface\.ts\b/,
  'check:manifests': /check-manifest-edges\.ts\b/,
  'check:public-surface': /check-public-surface\.ts\b/,
  'check:suppressions': /check-suppressions\.ts\b/,
  lint: /\bbun\s+run\s+lint\b/,
  test: /\bbun\s+run\s+test(?::fast)?\b/,
  typecheck: /\bbun\s+run\s+typecheck\b/,
}

function readText(root, path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function unique(values) {
  return [...new Set(values)]
}

function parseJustRecipes(text) {
  const recipes = new Map()
  let currentRecipe

  for (const line of text.split(/\r?\n/)) {
    const recipeMatch = /^([A-Za-z_][\w-]*)(?:\s+[^:=][^:]*)?:\s*(.*)$/.exec(line)
    if (recipeMatch) {
      const [, name, dependencyText] = recipeMatch
      currentRecipe = {
        commands: [],
        dependencies: parseJustDependencies(dependencyText),
      }
      recipes.set(name, currentRecipe)
      continue
    }

    if (currentRecipe && /^\s+/.test(line)) {
      const command = line.trim()
      if (command && !command.startsWith('#')) {
        currentRecipe.commands.push(command)
      }
    }
  }

  return recipes
}

function parseJustDependencies(text) {
  return text
    .replace(/\s+#.*$/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !token.includes('='))
}

function checkLeafForCommand(command) {
  for (const [pattern, label] of CHECK_COMMAND_LABELS) {
    if (pattern.test(command)) {
      return label
    }
  }
  return undefined
}

function verifyLeavesFromJustfile(text) {
  const recipes = parseJustRecipes(text)
  const verify = recipes.get('verify')
  if (!verify) {
    return []
  }

  const leaves = []
  for (const dependency of verify.dependencies) {
    if (dependency === 'check') {
      const check = recipes.get('check')
      if (!check) {
        leaves.push('check')
        continue
      }

      for (const command of check.commands) {
        leaves.push(checkLeafForCommand(command) ?? `check:${command}`)
      }
      continue
    }

    leaves.push(dependency)
  }

  return sortVerifyLeaves(unique(leaves))
}

function sortVerifyLeaves(leaves) {
  return leaves.toSorted((left, right) => {
    const leftIndex = VERIFY_LEAF_ORDER.indexOf(left)
    const rightIndex = VERIFY_LEAF_ORDER.indexOf(right)
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (
        (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
      )
    }
    return left.localeCompare(right)
  })
}

function parseHookCommands(text) {
  const commands = []

  for (const line of text.split(/\r?\n/)) {
    const runMatch = /^\s*run:\s*(.+?)\s*$/.exec(line)
    if (!runMatch) {
      continue
    }

    commands.push(stripYamlScalarQuotes(runMatch[1].trim()))
  }

  return commands
}

function stripYamlScalarQuotes(value) {
  if (value.length < 2) {
    return value
  }

  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function missingVerifyLeaves(verifyLeaves, hookCommands) {
  return verifyLeaves.filter((leaf) => {
    const coverage = HOOK_COVERAGE[leaf]
    if (!coverage) {
      return true
    }
    return !hookCommands.some((command) => coverage.test(command))
  })
}

function exerciseBadHook(verifyLeaves, hookCommands) {
  const perturbedHookCommands = hookCommands.filter((command) => !HOOK_COVERAGE.test.test(command))
  const missing = missingVerifyLeaves(verifyLeaves, perturbedHookCommands)
  const observed = missing.length > 0 ? 'FAIL' : 'PASS'

  return {
    label: 'firesOnBad',
    expected: 'FAIL',
    observed,
    perturbation: 'remove-hook-command:test',
    diagnostic: {
      code:
        observed === 'FAIL' ? 'hook.verify-closure.missing' : 'hook.verify-closure.unexpected-pass',
      missingLeaves: missing,
    },
  }
}

export async function evaluateHrcRuntimeVerifyEvidence({ root = process.cwd() } = {}) {
  const verifyLeaves = verifyLeavesFromJustfile(readText(root, 'justfile'))
  const hookCommands = parseHookCommands(readText(root, 'lefthook.yml'))
  const currentMissingLeaves = missingVerifyLeaves(verifyLeaves, hookCommands)
  const currentRun = {
    label: 'currentRun',
    status: currentMissingLeaves.length === 0 ? 0 : 1,
    facts: {
      verifyLeaves,
      hookCommands,
      missingLeaves: currentMissingLeaves,
    },
  }
  const firesOnBad = exerciseBadHook(verifyLeaves, hookCommands)
  const passed = currentRun.status === 0 && firesOnBad.observed === 'FAIL'

  return {
    id: PREDICATE_ID,
    result: {
      level: passed ? 'PRESENT' : 'MISSING',
      exercise: 'EXERCISED',
    },
    artifacts: {
      currentRun,
      firesOnBad,
    },
  }
}

function parseCliArgs(argv) {
  const options = {
    root: process.cwd(),
    output: undefined,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      options.root = argv[index + 1] ?? options.root
      index += 1
      continue
    }
    if (arg === '--output') {
      options.output = argv[index + 1]
      index += 1
      continue
    }
    if (!arg.startsWith('-')) {
      options.root = arg
    }
  }

  return options
}

async function runCli() {
  const options = parseCliArgs(process.argv.slice(2))
  const payload = await evaluateHrcRuntimeVerifyEvidence({ root: options.root })
  const text = `${JSON.stringify(payload, null, 2)}\n`
  if (options.output) {
    writeFileSync(resolve(options.output), text)
  } else {
    process.stdout.write(text)
  }
  process.exitCode = payload.result.level === 'PRESENT' ? 0 : 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await runCli()
}
