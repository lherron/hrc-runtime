// Use the real Foundry host's pure descriptor builder for the wire-shape check.
const { fleetDescriptor } = await import(process.argv[2])
const { joined, options } = await Bun.stdin.json()
console.log(JSON.stringify(fleetDescriptor(joined, options)))
