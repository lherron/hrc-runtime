#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { CliUsageError, consumeBody, parseDuration } from 'cli-kit'
import { Command, CommanderError } from 'commander'
import { HrcDomainError, type HrcMailEnvelopeState } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'

import {
  resolveMailActor,
  resolveMailDeliveryTarget,
  resolveMailTarget,
  resolveOwnMailbox,
} from './identity.js'
import { renderEnvelopeDetail, renderEnvelopeSummary } from './render.js'

type ClientFactory = () => HrcClient
type GlobalOptions = { json?: boolean }

function defaultClientFactory(): HrcClient {
  return new HrcClient(discoverSocket())
}

function readTextInput(value: string): string {
  return value === '-' ? readFileSync(0, 'utf8') : value
}

function readJsonFile(path: string, label: string): Record<string, unknown> {
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CliUsageError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new CliUsageError(`${label} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function parseJsonOrString(value: string): unknown {
  const text = readTextInput(value).trim()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function printEnvelopes(envelopes: Awaited<ReturnType<HrcClient['mailInbox']>>['envelopes']): void {
  if (envelopes.length === 0) {
    process.stdout.write('Inbox clear.\n')
    return
  }
  process.stdout.write(`${envelopes.map(renderEnvelopeSummary).join('\n\n')}\n`)
}

export function buildProgram(createClient: ClientFactory = defaultClientFactory): Command {
  const program = new Command()
    .name('hrcmail')
    .description('durable embedded-envelope mailbox for HRC agents')
    .option('--json', 'emit machine-readable JSON')
    .exitOverride()

  const global = (): GlobalOptions => program.opts<GlobalOptions>()

  program
    .command('inbox')
    .description('list actionable mail for the current scope')
    .option('--target <scope>', 'operator override for mailbox target')
    .action(async (opts: { target?: string }) => {
      const result = await createClient().mailInbox({
        actor: resolveMailActor(),
        targetSessionRef: resolveOwnMailbox(opts.target),
      })
      global().json ? printJson(result) : printEnvelopes(result.envelopes)
    })

  program
    .command('ack')
    .description('acknowledge one or more envelopes')
    .argument('<ids...>', 'envelope ids; schema-bound envelopes must be acknowledged alone')
    .option('--response <value>', 'response JSON/string or - for stdin')
    .action(async (ids: string[], opts: { response?: string }) => {
      const result = await createClient().ackMail({
        actor: resolveMailActor(),
        envelopeIds: ids,
        ...(opts.response === undefined ? {} : { response: parseJsonOrString(opts.response) }),
      })
      if (global().json) {
        printJson(result)
      } else {
        for (const item of result.results) {
          process.stdout.write(`${item.envelope.envelopeId} ${item.outcome}: acked\n`)
        }
      }
    })

  program
    .command('defer')
    .description('pause an envelope without terminally disposing it')
    .argument('<id>', 'envelope id')
    .requiredOption('--reason <text>', 'durable defer reason')
    .option('--retry-after <duration>', 'durable re-drive backstop')
    .action(async (id: string, opts: { reason: string; retryAfter?: string }) => {
      const retryAfterMs =
        opts.retryAfter === undefined ? undefined : parseDuration(opts.retryAfter)
      const result = await createClient().deferMail({
        actor: resolveMailActor(),
        envelopeId: id,
        reason: opts.reason,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })
      global().json
        ? printJson(result)
        : process.stdout.write(`${result.envelope.envelopeId} ${result.outcome}: deferred\n`)
    })

  program
    .command('send')
    .description('persist an envelope and return its stable receipt')
    .argument('<target>', 'target scope')
    .argument('[body]', 'envelope body (use - for stdin)')
    .option('--file <path>', 'read body from a file')
    .option('--kind <kind>', 'request|conversational', 'request')
    .option('--metadata <json>', 'structured metadata JSON')
    .option('--reply-schema <path>', 'Draft 2020-12 JSON Schema file (or - for stdin)')
    .option('--id <ingress-id>', 'stable ingress id for crash-safe retries')
    .action(
      async (
        target: string,
        bodyArg: string | undefined,
        opts: {
          file?: string
          kind: string
          metadata?: string
          replySchema?: string
          id?: string
        }
      ) => {
        const body = consumeBody({ positional: bodyArg, file: opts.file })
        if (!body) throw new CliUsageError('send requires a body (positional, -, or --file)')
        if (opts.kind !== 'request' && opts.kind !== 'conversational') {
          throw new CliUsageError('--kind must be request or conversational')
        }
        if (bodyArg === '-' && opts.replySchema === '-') {
          throw new CliUsageError('body and --reply-schema cannot both read stdin')
        }
        let metadata: Record<string, unknown> | undefined
        if (opts.metadata !== undefined) {
          const parsed = JSON.parse(opts.metadata) as unknown
          if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
            throw new CliUsageError('--metadata must be a JSON object')
          }
          metadata = parsed as Record<string, unknown>
        }
        const deliveryTarget = resolveMailDeliveryTarget(target)
        const result = await createClient().sendMail({
          ingressId: opts.id ?? `mail-ingress-${randomUUID()}`,
          from: resolveMailActor(),
          targetSessionRef: deliveryTarget.targetSessionRef,
          payload: {
            kind: opts.kind,
            body,
            ...(metadata === undefined ? {} : { metadata }),
          },
          ...(opts.replySchema === undefined
            ? {}
            : { replySchema: readJsonFile(opts.replySchema, 'reply schema') }),
          materializationIntent: deliveryTarget.materializationIntent,
        })
        global().json
          ? printJson(result)
          : process.stdout.write(
              `mail persisted: ${result.receipt.envelopeId} (receipt: ${result.receipt.ingressId})\n`
            )
      }
    )

  program
    .command('cat')
    .description('show one envelope, including terminal response')
    .argument('<id>', 'envelope id')
    .action(async (id: string) => {
      const result = await createClient().catMail({ envelopeId: id })
      global().json
        ? printJson(result)
        : process.stdout.write(`${renderEnvelopeDetail(result.envelope)}\n`)
    })

  program
    .command('ls')
    .description('list mailbox records')
    .option('--dead', 'show dead-letter envelopes')
    .option('--target <scope>', 'filter by target scope')
    .option('--state <state>', 'filter by exact state')
    .option('--limit <count>', 'maximum rows', '100')
    .action(async (opts: { dead?: boolean; target?: string; state?: string; limit: string }) => {
      const state = opts.state as HrcMailEnvelopeState | undefined
      const result = await createClient().listMail({
        ...(opts.dead ? { dead: true } : {}),
        ...(opts.target === undefined ? {} : { targetSessionRef: resolveMailTarget(opts.target) }),
        ...(state === undefined ? {} : { state }),
        limit: Number.parseInt(opts.limit, 10),
      })
      global().json ? printJson(result) : printEnvelopes(result.envelopes)
    })

  return program
}

export async function runCli(argv = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv)
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') return
    const message =
      error instanceof HrcDomainError || error instanceof Error ? error.message : String(error)
    process.stderr.write(`hrcmail: ${message}\n`)
    process.exitCode = error instanceof CommanderError ? 2 : 1
  }
}

if (import.meta.main) {
  await runCli()
}
