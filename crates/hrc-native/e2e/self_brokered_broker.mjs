// Real ASP broker protocol/ledger serving a self-brokered stub seat (T-13441).
// Its one driver, `turn-stub-driver`, runs every user input to completion with
// no model: turn.started, then turn.completed echoing the input, after
// continuation.updated naming the conversation key. The key is the one the
// start request continues, or a new one, so a carried continuation is visible
// as the same key on the successor's session. `stop` reports exited.
const [mode, modulePath, ...args] = process.argv.slice(2)
const { runBrokerCli, createNoopDriver } = await import(modulePath)

function createTurnStubDriver() {
  const base = createNoopDriver()
  let ctx
  let key
  let turns = 0
  const capabilities = {
    ...base.capabilities(),
    admission: { classes: ['queue', 'exclusive'] },
    bracketMintingMode: 'delivery-asserted',
    input: { ...base.capabilities().input, user: true, queue: true },
    continuation: { supported: true, provider: 'anthropic', keyKind: 'session' },
  }
  return {
    ...base,
    kind: 'turn-stub-driver',
    bracketMintingMode: 'delivery-asserted',
    capabilities: () => capabilities,
    probeAdmissionState: () => ({ harnessLocalQueueDepth: 0 }),
    async start(spec, driverCtx) {
      ctx = driverCtx
      key = spec.continuation?.key ?? `stub-conversation-${process.pid}`
      return { ok: true }
    },
    async applyInputNow(input) {
      turns += 1
      const turnId = `turn_stub_${turns}`
      const inputId = input.inputId
      const text = (input.content ?? []).map((p) => p.text ?? '').join('')
      ctx.emit('turn.started', { turnId }, { turnId, inputId })
      setTimeout(() => {
        ctx.emit('continuation.updated', { provider: 'anthropic', key }, { turnId, inputId })
        ctx.emit(
          'turn.completed',
          { turnId, status: 'completed', finalOutput: `stub ok: ${text.slice(0, 80)}` },
          { turnId, inputId }
        )
      }, 200)
      return { turnId }
    },
  }
}

process.argv = [process.argv[0], process.argv[1], mode, ...args]
await runBrokerCli({ additionalDrivers: [createTurnStubDriver] })
