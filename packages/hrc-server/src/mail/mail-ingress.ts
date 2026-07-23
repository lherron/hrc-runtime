import type { HrcMailSendRequest, HrcMailSendResponse } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

/**
 * The complete Wave-1 mail ingress seam: persist and return a stable receipt.
 *
 * It intentionally has no runtime, dispatch, busy-check, summon, or kicker
 * dependency. Later wake-up orchestration observes the committed envelope.
 */
export function persistMailIngress(
  db: HrcDatabase,
  request: HrcMailSendRequest
): HrcMailSendResponse {
  return db.mailEnvelopes.create(request)
}
