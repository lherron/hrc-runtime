import type { Command } from 'commander'
// Build-time data only: rusthrc never invokes Bun or the legacy CLI.
import { buildProgram } from '../../packages/hrc-cli/src/cli/build-program'
import { cmdAttach } from '../../packages/hrc-cli/src/cli/handlers-scope-attach'
import { printManagedScopeUsage } from '../../packages/hrc-cli/src/cli/handlers-scope-managed'
import { cmdResumeContinuation } from '../../packages/hrc-cli/src/cli/handlers-scope-start'
import { buildInfoText, renderRootHelp } from '../../packages/hrc-cli/src/cli/help'
const actionUsage: Record<string, string> = {}
for (const name of ['start', 'run', 'attach', 'resume'] as const) {
  let text = ''
  const original = process.stdout.write
  process.stdout.write = ((chunk: string) => {
    text += chunk
    return true
  }) as typeof original
  try {
    if (name === 'attach') await cmdAttach([])
    else if (name === 'resume') await cmdResumeContinuation([])
    else printManagedScopeUsage(name)
  } finally {
    process.stdout.write = original
  }
  actionUsage[name] = text
}
const root = buildProgram()
function completeHelp(command: Command): string {
  let output = ''
  command.configureOutput({
    writeOut: (text) => {
      output += text
    },
  })
  command.outputHelp()
  return output
}
function surface(command: Command, path: string[]): unknown {
  const usage = path.length === 1 ? actionUsage[path[0] ?? ''] : undefined
  return {
    path,
    name: command.name(),
    aliases: command.aliases(),
    usage: command.usage(),
    allowExcessArguments: (command as Command & { _allowExcessArguments: boolean })
      ._allowExcessArguments,
    ...(usage ? { actionUsage: usage } : {}),
    help: path.length ? completeHelp(command) : renderRootHelp(root, 'agent'),
    humanHelp: path.length ? completeHelp(command) : renderRootHelp(root, 'human'),
    arguments: command.registeredArguments.map((a) => ({
      name: a.name(),
      required: a.required,
      variadic: a.variadic,
    })),
    options: command.options.map((o) => ({
      flags: o.flags,
      short: o.short,
      long: o.long,
      required: o.required,
      optional: o.optional,
      mandatory: o.mandatory,
      negate: o.negate,
      ...(o.hidden ? { hidden: true } : {}),
      defaultValue: o.defaultValue,
      choices: o.argChoices,
    })),
    children: command.commands.map((c) => surface(c, [...path, c.name()])),
  }
}
// `hrc info` text per view without the node block; rusthrc renders THIS NODE.
const info = {
  agent: buildInfoText(root, undefined, 'agent'),
  human: buildInfoText(root, undefined, 'human'),
}
type SurfaceNode = {
  path: string[]
  help: string
  humanHelp: string
  children: SurfaceNode[]
}
type Graft = { parent: string[]; commandLine: [string, string]; node: SurfaceNode }
// Commands only rusthrc implements have no Commander owner: graft them from
// surface-native.json under their parent and list them in its Commands block,
// aligned to the parent's own `help [command]` row.
function graftNative(tree: SurfaceNode, grafts: Graft[]): SurfaceNode {
  for (const { parent, commandLine, node } of grafts) {
    let target = tree
    for (const name of parent) {
      const child = target.children.find((c) => c.path[c.path.length - 1] === name)
      if (!child) throw new Error(`surface-native.json: no parent ${parent.join(' ')}`)
      target = child
    }
    target.children.push(node)
    for (const key of ['help', 'humanHelp'] as const) {
      const lines = target[key].split('\n')
      const at = lines.findIndex((line) => /^ {2}help \[command\] +display help/.test(line))
      const column = lines[at]?.indexOf('display help') ?? -1
      if (at < 0 || commandLine[0].length + 4 > column)
        throw new Error(`surface-native.json: cannot list ${commandLine[0]} in ${parent.join(' ')}`)
      lines.splice(at, 0, `  ${commandLine[0].padEnd(column - 2)}${commandLine[1]}`)
      target[key] = lines.join('\n')
    }
  }
  return tree
}
const native = JSON.parse(
  await Bun.file(new URL('./surface-native.json', import.meta.url)).text()
) as { grafts: Graft[] }
const tree = graftNative(surface(root, []) as SurfaceNode, native.grafts)
const output = `${JSON.stringify({ ...tree, info }, null, 2)}\n`
const target = new URL('./surface.json', import.meta.url)
if (process.argv.includes('--check')) {
  if ((await Bun.file(target).text()) !== output)
    throw new Error('rusthrc surface drift; run bun crates/hrc-cli/generate-surface.ts')
} else await Bun.write(target, output)
