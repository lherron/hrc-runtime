import { describe, expect, it } from 'bun:test'

async function loadConsulModule(): Promise<{
  consulKvGet: (
    key: string,
    execProcess?: (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  ) => Promise<string | undefined>
}> {
  return await import('../consul-secrets.js')
}

describe('hrcchat Consul secrets helper', () => {
  it('shells consul kv get through execProcess, trims stdout, and returns the value', async () => {
    const calls: string[][] = []
    const { consulKvGet } = await loadConsulModule()

    const value = await consulKvGet('cfg/dev/anthropic/api_key', async (argv) => {
      calls.push(argv)
      return { stdout: '  secret-value\n', stderr: '', exitCode: 0 }
    })

    expect(calls).toEqual([['consul', 'kv', 'get', 'cfg/dev/anthropic/api_key']])
    expect(value).toBe('secret-value')
  })

  it('returns undefined when consul exits nonzero', async () => {
    const { consulKvGet } = await loadConsulModule()

    const value = await consulKvGet('missing/key', async () => ({
      stdout: '',
      stderr: 'No key exists at: missing/key',
      exitCode: 1,
    }))

    expect(value).toBeUndefined()
  })

  it('returns undefined when consul stdout is empty after trimming', async () => {
    const { consulKvGet } = await loadConsulModule()

    const value = await consulKvGet('empty/key', async () => ({
      stdout: ' \n\t',
      stderr: '',
      exitCode: 0,
    }))

    expect(value).toBeUndefined()
  })
})
