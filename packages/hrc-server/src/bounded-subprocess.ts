/** The daemon's bounded subprocess helper lives in hrc-core (T-10229). */
export {
  killSubprocess,
  type LongLivedSubprocess,
  runBoundedSubprocess,
  spawnLongLivedSubprocess,
  SubprocessOutputLimitError,
  SubprocessTimeoutError,
} from 'hrc-core'
