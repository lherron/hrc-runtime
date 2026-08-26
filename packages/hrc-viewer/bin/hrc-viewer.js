#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const srcPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const distPath = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const preferDist = process.env.HRC_VIEWER_USE_DIST === '1'
const entryPath =
  !preferDist && existsSync(srcPath) ? srcPath : existsSync(distPath) ? distPath : srcPath

const { runViewer } = await import(pathToFileURL(entryPath).href)
await runViewer()
