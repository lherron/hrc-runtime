import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  CAPTURE_VERIFIER_SCHEMA,
  type ResolveProviderTranscriptInput,
  type TranscriptResolution,
} from './types.js'

export async function resolveProviderTranscript(
  input: ResolveProviderTranscriptInput
): Promise<TranscriptResolution[]> {
  if (input.explicitPath !== undefined) {
    const warnings: string[] = []
    try {
      await access(input.explicitPath)
    } catch {
      warnings.push('explicit transcript path is not readable')
    }
    return [
      {
        schema: CAPTURE_VERIFIER_SCHEMA,
        path: input.explicitPath,
        confidence: 'explicit',
        evidence: ['explicit path supplied by caller'],
        warnings,
        alternatives: [],
      },
    ]
  }

  const searchRoots = input.searchRoots ?? defaultSearchRoots(input.candidate?.provider)
  const alternatives = await findRecentJsonl(searchRoots)
  const best = alternatives[0]
  if (best === undefined) {
    return []
  }
  return [
    {
      schema: CAPTURE_VERIFIER_SCHEMA,
      path: best,
      confidence: 'low',
      evidence: ['recent provider JSONL found under default transcript roots'],
      warnings: ['heuristic transcript discovery is not deterministic in verifier v1'],
      alternatives: alternatives.slice(1, 6),
    },
  ]
}

function defaultSearchRoots(provider: string | undefined): string[] {
  const home = homedir()
  if (provider === 'codex') return [join(home, '.codex')]
  if (provider === 'claude-code') return [join(home, '.claude')]
  return [join(home, '.codex'), join(home, '.claude')]
}

async function findRecentJsonl(roots: string[]): Promise<string[]> {
  const out: string[] = []
  for (const root of roots) {
    await walk(root, out, 0)
  }
  return out.slice(0, 20)
}

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 5 || out.length >= 20) return
  let entries: Array<{
    name: string
    isDirectory(): boolean
    isFile(): boolean
  }>
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(path, out, depth + 1)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(path)
    }
  }
}
