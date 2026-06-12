import { CliUsageError } from 'cli-kit'
import type { Command, CommanderError } from 'commander'

export const commanderErrorCommands = new WeakMap<CommanderError, Command>()

export function throwCommanderError(this: Command, err: CommanderError): never {
  commanderErrorCommands.set(err, this)
  throw err
}

function collectVisibleCommandNames(command: Command | undefined): string[] {
  if (!command) return []

  const names: string[] = []
  for (const candidate of command.createHelp().visibleCommands(command)) {
    names.push(candidate.name())
    const alias = candidate.alias()
    if (alias) names.push(alias)
  }
  return Array.from(new Set(names))
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      const substitution = (previous[j - 1] ?? 0) + cost
      current[j] = Math.min(deletion, insertion, substitution)
    }
    previous.splice(0, previous.length, ...current)
  }

  return previous[b.length] ?? Math.max(a.length, b.length)
}

function suggestSimilarCommand(unknownName: string, candidates: string[]): string | undefined {
  const uniqueCandidates = Array.from(new Set(candidates)).filter(
    (candidate) => candidate.length > 1
  )
  let bestDistance = 4
  let best: string[] = []

  for (const candidate of uniqueCandidates) {
    if (Math.abs(unknownName.length - candidate.length) > 3) continue

    const distance = levenshteinDistance(unknownName, candidate)
    const length = Math.max(unknownName.length, candidate.length)
    const similarity = (length - distance) / length
    if (similarity <= 0.4 || distance > 3) continue

    if (distance < bestDistance) {
      bestDistance = distance
      best = [candidate]
    } else if (distance === bestDistance) {
      best.push(candidate)
    }
  }

  best.sort((a, b) => a.localeCompare(b))
  return best[0]
}

function formatUnknownCommandError(
  unknownName: string,
  command: Command | undefined
): CliUsageError {
  const suggestion = suggestSimilarCommand(unknownName, collectVisibleCommandNames(command))
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : ''
  return new CliUsageError(`unknown command: ${unknownName}${hint}`)
}

export function normalizeCommanderError(err: CommanderError): Error {
  const unknownCommandMatch = err.message.match(/^error: unknown command '([^']+)'/)
  if (unknownCommandMatch?.[1]) {
    return formatUnknownCommandError(unknownCommandMatch[1], commanderErrorCommands.get(err))
  }
  return new CliUsageError(err.message)
}
