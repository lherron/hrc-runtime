#!/usr/bin/env bun
// WHY: `src` is not published (see `files` in package.json), so a bin pointing
// at ./src/cli.ts yields an installed binary that cannot start. Probe for src
// first so worktree edits stay live — hrc running worktree source is relied on
// across this platform — and fall back to dist in the published tarball.
// Mirrors agent-spaces packages/cli/bin/asp.js and the T-06648 fix (3fe9020).
//
// runCli() rather than a bare import: `import.meta.main` is false in the
// imported module, so its own entry guard never fires from here.

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const srcPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const distPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const preferDist = process.env.HRC_CLI_USE_DIST === '1'
const entryPath =
  !preferDist && existsSync(srcPath) ? srcPath : existsSync(distPath) ? distPath : srcPath

const { runCli } = await import(pathToFileURL(entryPath).href)
await runCli()
