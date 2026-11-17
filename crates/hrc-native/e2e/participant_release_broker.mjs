// The real ASP broker CLI with its exported idle fixture driver. With
// PARTICIPANT_RELEASE_IDENTITY set (JSON {releaseId,sourceCommit,builtAt}) it
// runs the way a release entrypoint does (scripts/asp-release/entries): the
// identity is handed to runBrokerCli and broker.hello reports it as `release`.
// Unset, hello carries no release, like a broker run from source.
const [mode, modulePath, ...args] = process.argv.slice(2)
{
  const { runBrokerCli, createNoopDriver } = await import(modulePath)
  process.argv = [process.argv[0], process.argv[1], mode, ...args]
  const raw = process.env.PARTICIPANT_RELEASE_IDENTITY
  await runBrokerCli({
    ...(raw ? { releaseIdentity: JSON.parse(raw) } : {}),
    additionalDrivers: [() => createNoopDriver()],
  })
}
