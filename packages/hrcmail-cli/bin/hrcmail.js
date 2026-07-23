#!/usr/bin/env bun
// Worktrees run source directly; published tarballs contain dist + this wrapper.
// Calling runCli explicitly is required because import.meta.main is false here.

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const srcPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const distPath = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const preferDist = process.env.HRCMAIL_CLI_USE_DIST === '1'
const entryPath =
  !preferDist && existsSync(srcPath) ? srcPath : existsSync(distPath) ? distPath : srcPath

const { runCli } = await import(pathToFileURL(entryPath).href)
await runCli()
