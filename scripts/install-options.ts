/**
 * `just` recipe arguments are positional, not named: `just install force-link=1`
 * assigns the literal string "force-link=1" to the FIRST parameter. Every install
 * option is therefore passed through as an opaque `name=value` token and parsed
 * here, so the documented call style (`just install allow-dirty=1`) means what it
 * says regardless of the order options are written in.
 */
export type InstallOptionName = 'no-sync' | 'force-sync' | 'force-link' | 'allow-dirty'

export type InstallOptions = {
  noSync: boolean
  forceSync: boolean
  forceLink: boolean
  allowDirty: boolean
}

const OPTION_NAMES: InstallOptionName[] = ['no-sync', 'force-sync', 'force-link', 'allow-dirty']

export function truthy(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === '') return false
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

/** Parse `name=value` tokens (a leading `--` is accepted); empty tokens are dropped. */
export function parseInstallOptions(tokens: string[]): InstallOptions {
  const values = new Map<InstallOptionName, string>()
  for (const raw of tokens) {
    const token = raw.trim()
    if (token === '') continue
    const bare = token.startsWith('--') ? token.slice(2) : token
    const split = bare.indexOf('=')
    const name = (split === -1 ? bare : bare.slice(0, split)) as InstallOptionName
    if (!OPTION_NAMES.includes(name)) {
      throw new Error(
        `Unknown install option: ${raw} (expected one of ${OPTION_NAMES.map((n) => `${n}=1`).join(', ')})`
      )
    }
    if (split === -1) {
      throw new Error(`Install option ${name} needs a value, for example ${name}=1`)
    }
    values.set(name, bare.slice(split + 1))
  }
  return {
    noSync: truthy(values.get('no-sync')),
    forceSync: truthy(values.get('force-sync')),
    forceLink: truthy(values.get('force-link')),
    allowDirty: truthy(values.get('allow-dirty')),
  }
}
