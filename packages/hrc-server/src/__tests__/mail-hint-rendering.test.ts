import { expect, test } from 'bun:test'
import { MAIL_HINT_TEXT, formatStopReason } from '../wrkq/stop-gate-handlers.js'

test('legacy mail hint is byte-identical', () => {
  expect(MAIL_HINT_TEXT(1)).toBe(
    "Mail hint from HRC: 1 envelope is waiting for this seat. Run `wrkc inbox` to see them and `wrkc show EN-xxxxx` to read one. Replying with `wrkc say <room> --to <sender> - <<'EOF'` answers it now; anything unanswered presents at turn end."
  )
  expect(MAIL_HINT_TEXT(2)).toBe(
    "Mail hint from HRC: 2 envelopes are waiting for this seat. Run `wrkc inbox` to see them and `wrkc show EN-xxxxx` to read one. Replying with `wrkc say <room> --to <sender> - <<'EOF'` answers it now; anything unanswered presents at turn end."
  )
})

test('prae hint uses the admitted mail verbs', () => {
  expect(MAIL_HINT_TEXT(2, true)).toBe(
    "Mail hint from HRC: 2 envelopes are waiting for this seat. Run `prae room mail find --to me` to see them and `prae room mail get EN-xxxxx` to read one. Replying with `prae room say <EN-id> --to <replyTo> - <<'EOF'` answers it now; anything unanswered presents at turn end."
  )
})

test('stop reason keeps legacy bytes and renders fenced prae deferral', () => {
  const decision = {
    decision: 'block' as const,
    unackedCount: 1,
    refusalCount: 1,
    totalRefusalCount: 1,
    envelopes: [
      {
        envelopeId: 'EN-123',
        roomKey: 'p/inbox',
        from: 'mable@p:primary',
        body: 'Please\n reply.',
      },
    ],
  }
  expect(formatStopReason(decision)).toBe(
    "Turn finish paused: 1 unanswered envelope remain (refusal 1/3).\n- p/inbox from mable@p:primary: Please reply.\nRun `wrkc inbox`, then reply (`wrkc say <room> --to <sender> - <<'EOF'`) or `wrkc defer` every envelope before stopping. Replying IS the ack; deferred envelopes leave this gate."
  )
  expect(formatStopReason(decision, true)).toBe(
    "Turn finish paused: 1 unanswered envelope remain (refusal 1/3).\n- p/inbox from mable@p:primary: Please reply.\nRun `prae room mail find --to me`, then read `prae room mail get <EN-id> --json` for the body, replyTo and etag. Reply (`prae room say <EN-id> --to <replyTo> - <<'EOF'`) or defer (`prae room mail defer <EN-id> --reason '<why>' --if-match <etag>`) every envelope before stopping. Replying IS the ack; deferred envelopes leave this gate."
  )
})
