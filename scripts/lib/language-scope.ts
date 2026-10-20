import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadHookScopeIgnore, parseHookScopeIgnore, worktreeRoot } from './hook-scope-ignore'

export function languageScope(
  paths: string[],
  root = worktreeRoot()
): { ts: boolean; cargo: boolean } {
  const tsIgnore = loadHookScopeIgnore(root)
  let cargoIgnore: ReturnType<typeof parseHookScopeIgnore>
  try {
    cargoIgnore = parseHookScopeIgnore(readFileSync(join(root, '.hookignore-cargo'), 'utf8'))
  } catch {
    return { ts: true, cargo: true }
  }
  return {
    ts: paths.some((path) => !tsIgnore.ignores(path)),
    cargo: paths.some((path) => !cargoIgnore.ignores(path)),
  }
}
