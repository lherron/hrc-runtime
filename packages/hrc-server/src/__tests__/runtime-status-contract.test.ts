import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_STATE_STATUS_VALUES,
  RUNTIME_STATUS_VALUES,
  isRuntimeStateStatus,
  isRuntimeStatus,
} from 'spaces-runtime-contracts'

import {
  HRC_RUNTIME_ROW_STATUS_PRODUCERS,
  HRC_RUNTIME_ROW_STATUS_VALUES,
  HRC_RUNTIME_STATE_JSON_STATUS_PRODUCERS,
  HRC_RUNTIME_STATE_JSON_STATUS_VALUES,
} from '../runtime-status-contract'

const HRC_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

const SOURCE_ROOTS = [
  'packages/hrc-server/src',
  'packages/hrc-core/src',
  'packages/hrc-store-sqlite/src',
] as const

function collectSourceFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const rel = relative(HRC_REPO_ROOT, path)
    if (
      rel.includes('/__tests__/') ||
      rel.includes('/validation/') ||
      rel.includes('/docs/') ||
      rel.includes('/node_modules/')
    ) {
      continue
    }
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path))
    } else if (path.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

function findMatchingParen(source: string, openParen: number): number {
  let depth = 0
  let quote: '"' | "'" | '`' | undefined
  let escaped = false
  for (let i = openParen; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function collectRuntimeWriteStatusLiterals(): string[] {
  const statuses = new Set<string>()
  const callPattern = /(?:this\.)?db\.runtimes\.(update|insert|updateStatus)\(/g
  const statusPattern = /\bstatus:\s*'([a-z_]+)'/g
  const updateStatusPattern = /updateStatus\([^,]+,\s*'([a-z_]+)'/g

  for (const root of SOURCE_ROOTS) {
    for (const file of collectSourceFiles(join(HRC_REPO_ROOT, root))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(callPattern)) {
        const openParen = match.index + match[0].length - 1
        const closeParen = findMatchingParen(source, openParen)
        expect(
          closeParen,
          `unclosed runtimes.${match[1]} call in ${relative(HRC_REPO_ROOT, file)}`
        ).toBeGreaterThan(openParen)
        const body = source.slice(openParen, closeParen + 1)
        for (const statusMatch of body.matchAll(statusPattern)) {
          statuses.add(statusMatch[1]!)
        }
        for (const statusMatch of body.matchAll(updateStatusPattern)) {
          statuses.add(statusMatch[1]!)
        }
      }
    }
  }
  return [...statuses].sort()
}

describe('runtime status contract with spaces-runtime-contracts', () => {
  test('classifies HRC runtime-state and runtime-row status producers', () => {
    expect(HRC_RUNTIME_STATE_JSON_STATUS_VALUES).toEqual([
      'starting',
      'ready',
      'busy',
      'stopping',
      'stopped',
      'failed',
      'disposed',
      'awaiting_input',
      'stale',
      'terminated',
    ])
    expect(HRC_RUNTIME_ROW_STATUS_VALUES).toEqual([
      ...HRC_RUNTIME_STATE_JSON_STATUS_VALUES,
      'dead',
      'adopted',
    ])

    for (const producer of HRC_RUNTIME_STATE_JSON_STATUS_PRODUCERS) {
      expect(isRuntimeStateStatus(producer.status), producer.producer).toBe(true)
      expect(RUNTIME_STATE_STATUS_VALUES).toContain(producer.status)
    }
    for (const producer of HRC_RUNTIME_ROW_STATUS_PRODUCERS) {
      expect(isRuntimeStatus(producer.status), producer.producer).toBe(true)
      expect(RUNTIME_STATUS_VALUES).toContain(producer.status)
    }

    expect(HRC_RUNTIME_STATE_JSON_STATUS_VALUES).not.toContain('adopted')
    expect(HRC_RUNTIME_STATE_JSON_STATUS_VALUES).not.toContain('dead')
    expect(HRC_RUNTIME_STATE_JSON_STATUS_VALUES).not.toContain('zombied')
    expect(HRC_RUNTIME_ROW_STATUS_VALUES).not.toContain('zombied')
  })

  test('fails when a runtime table status write is outside the classified runtime-row set', () => {
    const classified = new Set(HRC_RUNTIME_ROW_STATUS_VALUES)
    const unclassified = collectRuntimeWriteStatusLiterals().filter(
      (status) => !classified.has(status)
    )
    expect(unclassified).toEqual([])
  })
})
