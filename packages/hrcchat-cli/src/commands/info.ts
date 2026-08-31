import type { Command } from 'commander'

// The repository conformance check consumes this helper. It deliberately
// exposes no info prose or command roster now that every invocation is fenced.
export function buildInfoText(_program: Command): string {
  return ''
}
