/** A prose segment eligible to become the canonical final turn message. */
export type FinalTurnMessageCandidate = {
  text: string
  final?: boolean | undefined
}

/**
 * Select the canonical final assistant message for a turn.
 *
 * Empty text is discarded first. The last explicitly-final segment wins; for
 * legacy transports without finality flags, the last non-empty segment wins.
 * Both auto-reply actuation and transcript indexing use this function.
 */
export function selectFinalTurnMessage<T extends FinalTurnMessageCandidate>(
  candidates: readonly T[]
): T | undefined {
  const nonEmpty = candidates.filter((candidate) => candidate.text.length > 0)
  let selected = nonEmpty.at(-1)
  for (let index = nonEmpty.length - 1; index >= 0; index -= 1) {
    const candidate = nonEmpty[index]
    if (candidate?.final === true) {
      selected = candidate
      break
    }
  }
  return selected
}
