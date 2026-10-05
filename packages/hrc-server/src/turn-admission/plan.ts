import type { HrcSessionRecord } from 'hrc-core'
import type { PartialPlan, SubmissionRequest } from './types.js'
const admittedPlanBrand: unique symbol = Symbol('admitted-plan')
type PlanData = Readonly<Omit<PartialPlan, 'target' | 'preparedTarget'>> & {
  readonly session: HrcSessionRecord
  readonly request: Omit<SubmissionRequest, 'target'> & { readonly target: HrcSessionRecord }
}
export type AdmittedPlan = PlanData & { readonly [admittedPlanBrand]: true }
/** Restricted by check-admission-entry to the admission implementation. */
export function createAdmittedPlan(data: PlanData): AdmittedPlan {
  return { ...data, [admittedPlanBrand]: true }
}
