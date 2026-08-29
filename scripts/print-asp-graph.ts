#!/usr/bin/env bun
/**
 * One line at suite start naming BOTH ASP graphs: the source the suite resolves
 * and the locked tuple a release ships. See scripts/lib/asp-skew.ts for why.
 *
 * A banner rather than only a gate: a gate can be bypassed or simply not run, but
 * a line on every suite run cannot be forgotten, and this is the surface whose
 * meaning the dev workspace changed. Never exits non-zero — refusing is
 * check-asp-skew's job, and only where "green" is claimed to mean "shippable".
 */
import { resolve } from 'node:path'

import { formatAspGraphBanner, readAspSkew } from './lib/asp-skew'

console.error(formatAspGraphBanner(await readAspSkew(resolve(import.meta.dir, '..'))))
