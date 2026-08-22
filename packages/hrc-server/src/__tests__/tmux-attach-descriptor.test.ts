import { describe, expect, it } from 'bun:test'
import { basename, isAbsolute } from 'node:path'

import { createTmuxManager, resolveTmuxBinary } from '../tmux'

describe('TmuxManager attach descriptors', () => {
  it('emits an absolute executable path for execution outside the daemon PATH', () => {
    const descriptor = createTmuxManager({ socketPath: '/tmp/hrc-test.sock' }).getAttachDescriptor(
      'hrc-test:tui'
    )

    expect(isAbsolute(descriptor.argv[0] ?? '')).toBe(true)
    expect(basename(descriptor.argv[0] ?? '')).toBe('tmux')
    expect(descriptor.argv.slice(1)).toEqual([
      '-S',
      '/tmp/hrc-test.sock',
      'attach-session',
      '-t',
      'hrc-test:tui',
    ])
  })

  it('fails closed when the daemon cannot resolve the executable', () => {
    expect(() => resolveTmuxBinary('tmux', '')).toThrow('was not found on PATH')
  })
})
