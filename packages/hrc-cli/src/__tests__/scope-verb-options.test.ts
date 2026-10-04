/**
 * Every option a scope verb declares is stepped over by `parseScopePrompt`
 * together with its value, so the prompt is still the prompt (T-10226; the
 * 68508938 defect was a value-taking flag missing from a hand-kept set, whose
 * value then collided with the real prompt).
 */
import { describe, expect, it } from 'bun:test'

import { parseScopePrompt } from '../cli/scope'
import { resumeOptions, runOptions, startOptions } from '../cli/scope-verb-options'

const verbs = [
  { name: 'start', command: 'start', options: startOptions },
  { name: 'run', command: 'run', options: runOptions },
  { name: 'resume', command: 'run', options: resumeOptions },
] as const

describe('scope verb options', () => {
  for (const verb of verbs) {
    for (const option of verb.options()) {
      const flag = option.long ?? option.short
      if (flag === undefined || flag === '-p' || flag === '--prompt-file') continue
      const takesValue = option.required || option.optional
      it(`${verb.name} ${flag} leaves the positional prompt intact`, async () => {
        const args = ['agent@project', flag, ...(takesValue ? ['flag-value'] : []), 'the prompt']
        const prompt = await parseScopePrompt(args, {
          command: verb.command,
          options: verb.options(),
        })
        expect(prompt).toBe('the prompt')
      })
    }
  }
})
