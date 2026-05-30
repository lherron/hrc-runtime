import { describe, expect, it } from 'bun:test'

import { chooseDefaultProjectId } from '../cli'

describe('chooseDefaultProjectId — ASP_PROJECT vs cwd precedence', () => {
  it('uses ASP_PROJECT when cwd cannot infer a project', () => {
    expect(
      chooseDefaultProjectId({ aspProject: 'ghostmux', cwdProject: undefined, interactive: true })
    ).toEqual({ projectId: 'ghostmux', cwdOverrodeAsp: false })
  })

  it('uses cwd when ASP_PROJECT is unset', () => {
    expect(
      chooseDefaultProjectId({
        aspProject: undefined,
        cwdProject: 'hrc-runtime',
        interactive: true,
      })
    ).toEqual({ projectId: 'hrc-runtime', cwdOverrodeAsp: false })
  })

  it('keeps ASP_PROJECT when it agrees with cwd (no conflict)', () => {
    expect(
      chooseDefaultProjectId({
        aspProject: 'hrc-runtime',
        cwdProject: 'hrc-runtime',
        interactive: true,
      })
    ).toEqual({ projectId: 'hrc-runtime', cwdOverrodeAsp: false })
  })

  it('INTERACTIVE conflict: cwd wins over a stale ASP_PROJECT and flags the override', () => {
    // The reported bug: `hrc run clod` in hrc-runtime/ with ASP_PROJECT=ghostmux
    // must resolve to the cwd project, not ghostmux.
    expect(
      chooseDefaultProjectId({
        aspProject: 'ghostmux',
        cwdProject: 'hrc-runtime',
        interactive: true,
      })
    ).toEqual({ projectId: 'hrc-runtime', cwdOverrodeAsp: true })
  })

  it('NON-INTERACTIVE conflict: ASP_PROJECT stays authoritative (agents/scripts)', () => {
    // Agent runtimes invoke hrc without a TTY; their ASP_PROJECT is canonical
    // and must not be overridden by whatever directory they happen to be in.
    expect(
      chooseDefaultProjectId({
        aspProject: 'ghostmux',
        cwdProject: 'hrc-runtime',
        interactive: false,
      })
    ).toEqual({ projectId: 'ghostmux', cwdOverrodeAsp: false })
  })

  it('returns undefined when neither signal is present', () => {
    expect(
      chooseDefaultProjectId({ aspProject: undefined, cwdProject: undefined, interactive: true })
    ).toEqual({ projectId: undefined, cwdOverrodeAsp: false })
  })
})
