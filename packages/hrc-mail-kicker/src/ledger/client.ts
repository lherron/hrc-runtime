import type {
  WrkqEnvelope,
  WrkqEnvelopeFailParams,
  WrkqEnvelopePendingView,
  WrkqEnvelopePendingViewParams,
  WrkqEnvelopePresentParams,
  WrkqEnvelopePresentResult,
  WrkqEnvelopeShowParams,
  WrkqMonitorEventsView,
  WrkqMonitorEventsViewParams,
} from './types.js'

/** wrkq could not be reached, or did not answer in time. Never a ledger refusal. */
export class WrkqLedgerUnavailableError extends Error {
  constructor(
    message: string,
    readonly method: string
  ) {
    super(message)
    this.name = 'WrkqLedgerUnavailableError'
  }
}

/** wrkq answered, and the answer was an error frame. The ledger spoke; it said no. */
export class WrkqLedgerRequestError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'WrkqLedgerRequestError'
  }
}

/** The exact collaboration-ledger surface used by the mail kicker. */
export type MailKickerLedger = {
  pendingView(params: WrkqEnvelopePendingViewParams): Promise<WrkqEnvelopePendingView>
  present(params: WrkqEnvelopePresentParams): Promise<WrkqEnvelopePresentResult>
  fail(params: WrkqEnvelopeFailParams): Promise<WrkqEnvelope>
  envelopeShow(params: WrkqEnvelopeShowParams): Promise<WrkqEnvelope>
  eventsView(params: WrkqMonitorEventsViewParams): Promise<WrkqMonitorEventsView>
}
