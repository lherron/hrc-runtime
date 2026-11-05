// Real ASP broker protocol/ledger with its exported idle fixture driver.
const [mode, modulePath, ...args] = process.argv.slice(2)
if (mode === 'descriptor') {
  const { neutralParticipantBrokerDescriptorHash, neutralSpecHash, neutralStartRequestHash } =
    await import(`${args[0]}/node_modules/spaces-runtime-contracts/dist/index.js`)
  const d = await Bun.stdin.json()
  const spec = d.harnessInvocation.startRequest.spec
  d.harnessInvocation.specHash = neutralSpecHash(spec)
  d.harnessInvocation.startRequestHash = neutralStartRequestHash(d.harnessInvocation.startRequest)
  spec.correlation.startRequestHash = d.harnessInvocation.startRequestHash
  d.descriptorHash = neutralParticipantBrokerDescriptorHash(d)
  spec.correlation.selectedProfileHash = d.descriptorHash
  console.log(JSON.stringify(d))
} else {
  const { runBrokerCli, createNoopDriver } = await import(modulePath)
  process.argv = [process.argv[0], process.argv[1], mode, ...args]
  await runBrokerCli({
    additionalDrivers: [
      () => {
        const driver = createNoopDriver()
        for (const name of ['stop', 'dispose']) {
          const original = driver[name].bind(driver)
          driver[name] = async (...params) => {
            const { appendFileSync } = await import('node:fs')
            appendFileSync(
              process.env.PARTICIPANT_EVICTION_EFFECTS,
              `${JSON.stringify({ method: name })}\n`
            )
            return original(...params)
          }
        }
        return driver
      },
    ],
  })
}
