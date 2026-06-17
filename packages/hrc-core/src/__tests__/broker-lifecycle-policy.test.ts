import { describe, expect, it } from 'bun:test'

import {
  BROKER_TO_HRC_LIFECYCLE_KIND,
  BROKER_TO_HRC_LIFECYCLE_POLICY_HASH,
  BROKER_TO_HRC_LIFECYCLE_POLICY_ID,
  BROKER_TO_HRC_LIFECYCLE_POLICY_VERSION,
  brokerToHrcLifecyclePolicyHash,
} from '../broker-lifecycle-policy.js'

describe('broker-to-HRC lifecycle policy identity', () => {
  it('exports a stable v1 identity and deterministic vocabulary hash', () => {
    expect(BROKER_TO_HRC_LIFECYCLE_POLICY_ID).toBe('hrc-core.broker-to-hrc-lifecycle/v1')
    expect(BROKER_TO_HRC_LIFECYCLE_POLICY_VERSION).toBe('v1')
    expect(BROKER_TO_HRC_LIFECYCLE_POLICY_HASH).toBe(
      brokerToHrcLifecyclePolicyHash(BROKER_TO_HRC_LIFECYCLE_KIND)
    )
    expect(
      brokerToHrcLifecyclePolicyHash({
        ...BROKER_TO_HRC_LIFECYCLE_KIND,
        'new.event': 'turn.new_event',
      })
    ).not.toBe(BROKER_TO_HRC_LIFECYCLE_POLICY_HASH)
  })
})
