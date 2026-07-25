#!/usr/bin/env bun
/**
 * Env-hygiene gate (2026-07-25 ruling): bun auto-loads repo-root `.env`,
 * `.env.local`, and `.env.<NODE_ENV>` into every bun process started from
 * this directory — including installed CLIs and their child processes. Those
 * files therefore carry project CONTEXT only. Credential- and principal-class
 * keys live in `.env.secrets` (never auto-loaded; consumers source it
 * explicitly) or behind *_FILE indirection.
 *
 * This script fails the bar when a credential-class key appears in any
 * auto-loaded env file at the repo root.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isCredentialClassKey, parseDotEnvContent } from 'hrc-sdk'

const AUTO_LOADED_FILES = ['.env', '.env.local', '.env.development', '.env.production', '.env.test']

export function scanEnvFile(content: string): string[] {
  return Object.keys(parseDotEnvContent(content)).filter(isCredentialClassKey)
}

function main(): void {
  const root = process.cwd()
  const violations: string[] = []
  for (const name of AUTO_LOADED_FILES) {
    let content: string
    try {
      content = readFileSync(join(root, name), 'utf8')
    } catch {
      continue
    }
    for (const key of scanEnvFile(content)) {
      violations.push(`${name}: ${key}`)
    }
  }
  if (violations.length > 0) {
    console.error('env-hygiene violations (credential-class keys in auto-loaded env files):')
    for (const violation of violations) {
      console.error(`  ${violation}`)
    }
    console.error('Move these to .env.secrets (opt-in only) or *_FILE indirection.')
    process.exit(1)
  }
  console.log('env-hygiene: auto-loaded env files are credential-free')
}

if (import.meta.main) main()
