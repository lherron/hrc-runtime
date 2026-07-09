import { describe, expect, test } from 'bun:test'

describe('installed broker tmux prompt delivery', () => {
  test('submits a 100KB prompt through file-backed tmux paste without putting the prompt in argv', async () => {
    const brokerTmuxUrl = new URL(
      '../../../../node_modules/spaces-harness-broker/dist/runtime/tmux.js',
      import.meta.url
    )
    const mod = (await import(brokerTmuxUrl.href)) as {
      createTmuxPaneController?: (options: {
        socketPath: string
        tmuxBin?: string
        exec: (argv: string[]) => Promise<{ stdout: string; stderr: string }>
        lease: {
          socketPath: string
          paneId: string
          allowedOps: {
            inspect: boolean
            sendInput: boolean
            sendInterrupt: boolean
            capture: boolean
          }
        }
      }) => {
        sendKeys: (text: string) => Promise<void>
      }
    }

    expect(mod.createTmuxPaneController).toBeDefined()

    const prompt = `prompt:${'x'.repeat(100 * 1024)}`
    const calls: string[][] = []
    const controller = mod.createTmuxPaneController({
      socketPath: '/tmp/hrc-large-prompt-test.sock',
      tmuxBin: 'tmux',
      exec: async (argv) => {
        calls.push(argv)
        return { stdout: '', stderr: '' }
      },
      lease: {
        socketPath: '/tmp/hrc-large-prompt-test.sock',
        paneId: '%77',
        allowedOps: {
          inspect: true,
          sendInput: true,
          sendInterrupt: true,
          capture: false,
        },
      },
    })

    if (controller === undefined) {
      throw new Error('spaces-harness-broker did not expose createTmuxPaneController')
    }

    // T-05577: HRC consumes ASP's broker snapshot. Large broker prompts must be
    // loaded from a temp file into a tmux buffer, pasted, and then submitted; the
    // raw prompt must never ride in `send-keys -l` or `set-buffer ... <prompt>`.
    await controller.sendKeys(prompt)

    const argvStrings = calls.map((argv) => argv.join('\0'))
    expect(calls.some((argv) => argv.includes('load-buffer'))).toBe(true)
    expect(calls.some((argv) => argv.includes('paste-buffer'))).toBe(true)
    expect(calls.at(-1)).toContain('Enter')
    expect(argvStrings.some((argv) => argv.includes(prompt))).toBe(false)
  })
})
