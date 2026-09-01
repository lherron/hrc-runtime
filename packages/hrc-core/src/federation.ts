/**
 * Path to a daemon-materialized, mode-0600 wrkq claim credential. The secret
 * itself never crosses the broker's observable dispatch-env channel.
 */
export const HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV = 'HRC_TASK_CLAIM_CREDENTIAL_FILE'
