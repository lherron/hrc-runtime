import type { HrcTopNavAction } from './nav-state.js'

export type HrcTopKeyPrefix = 'g' | 'mark' | 'jump' | undefined

export type HrcTopKeyIntent =
  | HrcTopNavAction
  | { type: 'action'; key: string }
  | { type: 'command' }
  | { type: 'focus' }
  | { type: 'quit' }
  | { type: 'help' }
  | { type: 'filter' }
  | { type: 'searchNext' }
  | { type: 'searchPrev' }
  | { type: 'noop'; reason: string }

export type HrcTopKeyResult = {
  intent?: HrcTopKeyIntent | undefined
  prefix?: HrcTopKeyPrefix | undefined
}

export function interpretHrcTopKey(input: string, prefix?: HrcTopKeyPrefix): HrcTopKeyResult {
  if (prefix === 'g') {
    return input === 'g'
      ? { intent: { type: 'key', key: 'gg' } }
      : { intent: { type: 'noop', reason: 'unknown g command' } }
  }

  if (prefix === 'mark') {
    return input.length === 1
      ? { intent: { type: 'mark', name: input } }
      : { intent: { type: 'noop', reason: 'mark name must be one character' } }
  }

  if (prefix === 'jump') {
    return input.length === 1
      ? { intent: { type: 'jumpToMark', name: input } }
      : { intent: { type: 'noop', reason: 'mark name must be one character' } }
  }

  switch (input) {
    case 'j':
      return { intent: { type: 'key', key: 'j' } }
    case 'k':
      return { intent: { type: 'key', key: 'k' } }
    case 'G':
      return { intent: { type: 'key', key: 'G' } }
    case '\u0004':
      return { intent: { type: 'key', key: 'ctrl-d' } }
    case '\u0015':
      return { intent: { type: 'key', key: 'ctrl-u' } }
    case '\u0006':
      return { intent: { type: 'key', key: 'ctrl-f' } }
    case '\u0002':
      return { intent: { type: 'key', key: 'ctrl-b' } }
    case '/':
      return { intent: { type: 'filter' } }
    case 'n':
      return { intent: { type: 'searchNext' } }
    case 'N':
      return { intent: { type: 'searchPrev' } }
    case ':':
      return { intent: { type: 'command' } }
    case 'o':
    case 'a':
    case 'r':
    case 'R':
    case 'e':
    case 'c':
    case 'i':
      return { intent: { type: 'action', key: input } }
    case 'g':
      return { prefix: 'g' }
    case 'm':
      return { prefix: 'mark' }
    case "'":
      return { prefix: 'jump' }
    case '\r':
    case '\n':
      return { intent: { type: 'focus' } }
    case '?':
      return { intent: { type: 'help' } }
    case 'q':
    case '\u0003':
      return { intent: { type: 'quit' } }
    case 'h':
    case 'l':
      return { intent: { type: 'noop', reason: 'pane/group movement is not active yet' } }
    default:
      return { intent: { type: 'noop', reason: 'unmapped key' } }
  }
}
