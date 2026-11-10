// Real ASP broker protocol/ledger with its exported idle fixture driver.
const [mode, modulePath, ...args] = process.argv.slice(2)
{
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
