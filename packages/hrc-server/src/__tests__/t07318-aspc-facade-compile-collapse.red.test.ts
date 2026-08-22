/**
 * T-07318 — P1: collapse hrc-server in-process compiler paths onto the aspc facade RPC.
 *
 * Red bar, one test per live acceptance criterion:
 *
 *   AC #1 — DEP REPOINT. `packages/hrc-server/package.json` must declare
 *   `spaces-aspc-facade` (the cohosted-broker composition package that now owns the
 *   `aspc-facade` bin spawned at `option-resolvers.ts:32`) in place of `spaces-aspc`.
 *   hrc-server imports no `spaces-aspc` module in source — the dependency exists purely
 *   to place `node_modules/.bin/aspc-facade` — so the manifest IS the deliverable.
 *
 *   AC #3 — COMPILE REROUTE. No hrc-server production source may reach an in-process
 *   `agent-spaces` COMPILE surface as a value; compile goes out of process through the
 *   aspc facade JSON-RPC seam. Deliberately NOT constrained: the TURN path stays
 *   in-process against the relocated turn-runner, so `sdk-adapter.ts:20`'s
 *   `createAgentSpacesClient` import from `spaces-turn-runner` remains legal, as do
 *   type-only `agent-spaces` imports (erased at runtime, they bind no compiler) and
 *   non-compile value imports such as `target-view.ts`'s `checkContinuationArtifact`.
 *
 *   AC #3 — DUPLICATE RETIREMENT. The harness/provider -> CLI-frontend mapping tables
 *   duplicated at `cli-adapter.ts:46-56` (a dup of the compiler's
 *   `compile-runtime-plan.ts:531-553`) must be gone from the adapter. Asserted as
 *   absence of the declaration, not as shape: two structurally identical mapping
 *   literals are mutually assignable, so a `toEqual` on a copied literal would pass
 *   against a surviving duplicate.
 *
 * AC #2 (REQUIRED_BOUNDARY_CHECKS consumption) is deliberately untested here: it was
 * deferred out of this room in full by ruling #20164 (task comment C-15538).
 *
 * Evidence form is the one the amendment names for AC #3: suite + import resolution.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const HRC_SERVER_PACKAGE_JSON = resolve(REPO_ROOT, 'packages/hrc-server/package.json')
const HRC_SERVER_SRC = resolve(REPO_ROOT, 'packages/hrc-server/src')
const CLI_ADAPTER = resolve(HRC_SERVER_SRC, 'agent-spaces-adapter/cli-adapter.ts')

/** The package that hosts the in-process ASP compiler client. */
const COMPILE_SURFACE_PACKAGE = 'agent-spaces'

/**
 * Named `agent-spaces` exports that hand back a compiler. `createAgentSpacesClient`
 * exposes `buildProcessInvocationSpec`; both are the substitution-blocking surfaces the
 * task description names.
 */
const COMPILE_SURFACE_BINDINGS = new Set(['createAgentSpacesClient', 'buildProcessInvocationSpec'])

/** Duplicate mapping tables the reroute retires (cli-adapter.ts:46-56). */
const RETIRED_DUPLICATE_TABLES = ['HARNESS_ID_TO_FRONTEND', 'PROVIDER_TO_FRONTEND']

// ── Import-resolution helpers ────────────────────────────────────────────────
//
// The tempered `(?!\bimport\b)` / `(?!\bexport\b)` bodies stop a lazy clause from
// spanning a preceding side-effect import into the next statement's specifier.

const IMPORT_WITH_CLAUSE = /^import\s+((?:(?!\bimport\b)[\s\S])*?)\s+from\s+['"]([^'"]+)['"]/gm
const REEXPORT_WITH_CLAUSE = /^export\s+((?:(?!\bexport\b)[\s\S])*?)\s+from\s+['"]([^'"]+)['"]/gm
const SIDE_EFFECT_IMPORT = /^import\s+['"]([^'"]+)['"]/gm

type Binding = {
  /** Source text of the binding, e.g. `createAgentSpacesClient as compile`. */
  text: string
  /** True for a named binding inside `{ ... }`; false for default/namespace. */
  named: boolean
}

function isCompileSurfacePackage(specifier: string): boolean {
  return (
    specifier === COMPILE_SURFACE_PACKAGE || specifier.startsWith(`${COMPILE_SURFACE_PACKAGE}/`)
  )
}

/**
 * Value bindings introduced by an import/export clause. Type-only clauses
 * (`import type { ... }`) and inline `type` specifiers are erased at runtime and
 * therefore bind no compiler, so they yield nothing.
 */
function valueBindings(clause: string): Binding[] {
  const trimmed = clause.trim()
  if (trimmed.startsWith('type ') || trimmed === 'type') {
    return []
  }

  const bindings: Binding[] = []
  const braceStart = trimmed.indexOf('{')
  const head = (braceStart === -1 ? trimmed : trimmed.slice(0, braceStart)).replace(/,\s*$/, '')
  if (head.trim()) {
    bindings.push({ text: head.trim(), named: false })
  }

  if (braceStart !== -1) {
    const inner = trimmed.slice(braceStart + 1, trimmed.lastIndexOf('}'))
    for (const raw of inner.split(',')) {
      const specifier = raw.trim()
      if (specifier && !specifier.startsWith('type ')) {
        bindings.push({ text: specifier, named: true })
      }
    }
  }

  return bindings
}

/** Local name a binding introduces, unwrapping `x as y` aliases. */
function importedName(binding: Binding): string {
  return binding.text.split(/\s+as\s+/)[0]?.trim() ?? binding.text
}

function compileSurfaceViolations(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const where = relative(REPO_ROOT, file)
  const violations: string[] = []

  // Side-effect imports carry no clause, so a lazy clause body would otherwise run
  // past one and swallow the following statement's specifier. Report them separately
  // and scan the remainder for bindings.
  const clauseSource = source.replace(SIDE_EFFECT_IMPORT, '')

  for (const pattern of [IMPORT_WITH_CLAUSE, REEXPORT_WITH_CLAUSE]) {
    for (const match of clauseSource.matchAll(pattern)) {
      const specifier = match[2] ?? ''
      if (!isCompileSurfacePackage(specifier)) {
        continue
      }

      for (const binding of valueBindings(match[1] ?? '')) {
        // Default and namespace value bindings expose the whole compiler surface;
        // named bindings only matter when they ARE a compile surface.
        const reachesCompiler =
          !binding.named || COMPILE_SURFACE_BINDINGS.has(importedName(binding))
        if (reachesCompiler) {
          violations.push(`${where}: value binding \`${binding.text}\` from '${specifier}'`)
        }
      }
    }
  }

  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    const specifier = match[1] ?? ''
    if (isCompileSurfacePackage(specifier)) {
      violations.push(`${where}: side-effect import of '${specifier}'`)
    }
  }

  return violations
}

/** Production hrc-server sources: tests and build output are out of scope. */
function productionSources(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'dist' && entry.name !== 'node_modules') {
        files.push(...productionSources(full))
      }
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

// ── AC #1: dependency repoint ────────────────────────────────────────────────

describe('T-07318 AC #1 — hrc-server depends on the aspc facade composition package', () => {
  test('package.json declares spaces-aspc-facade instead of spaces-aspc', () => {
    const manifest = JSON.parse(readFileSync(HRC_SERVER_PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = Object.keys(manifest.dependencies ?? {})

    // spaces-aspc-facade owns the `aspc-facade` bin that option-resolvers.ts:32 spawns.
    expect(dependencies).toContain('spaces-aspc-facade')
    // The repoint replaces the old name; hrc-server imports no `spaces-aspc` module,
    // so leaving it declared would strand a second, bin-less claim on the seam.
    expect(dependencies).not.toContain('spaces-aspc')
  })
})

// ── AC #3: compile reroute through the facade RPC ────────────────────────────

describe('T-07318 AC #3 — compile leaves hrc-server only through the aspc facade RPC', () => {
  test('no production source value-imports an in-process agent-spaces compile surface', () => {
    const violations = productionSources(HRC_SERVER_SRC).sort().flatMap(compileSurfaceViolations)

    expect(violations).toEqual([])
  })
})

// ── Anti-vacuity control for the scan above ──────────────────────────────────

describe('T-07318 AC #3 — the compile-surface detector still detects', () => {
  /**
   * The scan above asserts an EMPTY violation list, which a detector that has gone
   * blind satisfies just as well as a clean repo — once the implementer lands, all
   * three criteria tests are green and assertion-negative, so nothing else would
   * notice. The realistic blinding path is the source tree moving out from under
   * `packages/hrc-server/src`, not malice. This control runs the same detector over
   * SYNTHETIC source, so it cannot drift with the tree, and asserts BOTH directions:
   * the violating forms are caught, and the permitted forms are still spared.
   */
  test('flags the violating import forms and spares the permitted ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 't07318-detector-'))
    try {
      const fixture = join(dir, 'synthetic-source.ts')
      writeFileSync(
        fixture,
        [
          // Violating: reach the in-process compiler as a value.
          "import * as compilerNamespace from 'agent-spaces'",
          "import { createAgentSpacesClient } from 'agent-spaces'",
          "import { createAgentSpacesClient as compileAlias } from 'agent-spaces'",
          "import 'agent-spaces'",
          // Permitted: erased at runtime, so it binds no compiler.
          "import type { ProcessInvocationSpec } from 'agent-spaces'",
          // Permitted: the TURN path stays in-process against the relocated surface.
          "import { createAgentSpacesClient as turnClient } from 'spaces-turn-runner'",
          '',
        ].join('\n')
      )

      const violations = compileSurfaceViolations(fixture)
      const rendered = violations.join('\n')

      // Positive half — the detector fires on every violating form.
      expect(rendered).toContain('`* as compilerNamespace`')
      expect(rendered).toContain('`createAgentSpacesClient`')
      expect(rendered).toContain('`createAgentSpacesClient as compileAlias`')
      expect(rendered).toContain("side-effect import of 'agent-spaces'")

      // Negative half — the detector still discriminates. The exact count is what
      // proves the permitted forms produced nothing, not merely that they differ.
      expect(rendered).not.toContain('ProcessInvocationSpec')
      expect(rendered).not.toContain('spaces-turn-runner')
      expect(violations).toHaveLength(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── AC #3: duplicate harness mapping retirement ──────────────────────────────

describe('T-07318 AC #3 — the duplicated harness mapping table is retired', () => {
  test('cli-adapter.ts declares no local harness/provider -> frontend mapping', () => {
    const source = readFileSync(CLI_ADAPTER, 'utf8')

    const surviving = RETIRED_DUPLICATE_TABLES.filter((name) =>
      new RegExp(`\\b(?:const|let|var|enum|function|class)\\s+${name}\\b`).test(source)
    )

    expect(surviving).toEqual([])
  })
})
