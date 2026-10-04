# Test doubles

Ruling R2 (T-10231). A test double that is not checked against the interface it
stands in for can agree with its author's mistake: T-10226 found 16 SHAs where
one did. `scripts/check-test-doubles.ts` enforces two rules in `just check`. The
script's header comment is the authoritative definition; this page is the
operator summary.

## 1. Doubles are typed against production

**A double** is a declaration in a test source (anything under `__tests__/`, or
named `*.test.ts` / `*.fixture.ts`, in `packages/` or `scripts/`) whose name
starts with `fake`/`stub`/`mock` (`fakeClient`, `FakeClock`, `stub_x`, `mock`)
or ends in `Double` (`tmuxManagerDouble`), and which defines a shape: a class, a
function, or a variable initialized with an object literal, arrow function or
function expression. `const fake = new FakeClock()` and `const stubServer =
Bun.serve(...)` are not doubles; their type comes from what built them. A
function returning `void` or `Promise<void>` installs a double and is not one.

**Typed** means `implements X` on a class, a return type on a function, or a
type annotation or trailing `satisfies X` on an object literal, where `X` names
a type imported from production (a package, or a relative path that is not a
test source). `as X` is a cast and does not count. A type declared in test code
does not count. Neither does `any`, `unknown`, `object`, `{}`, `Function` or
`Record<K, unknown>`.

**Conforming** means typed and with no type error inside the declaration.
Package tsconfigs exclude `*.test.ts`, so `tsc` never checks a test file; the
check type-checks the files that declare typed doubles itself and counts only
the errors that start inside a double.

Prefer `satisfies`:

```ts
import type { WrkqLedgerClient } from '../wrkq/ledger-client'

const fakeLedger = {
  close: async () => {},
} satisfies Partial<WrkqLedgerClient>
```

The baseline (`scripts/test-double-baseline.json`, key `nonconforming`) holds
the doubles that predate the rule, counted per file. A file above its count
fails. A file below its count also fails until you lower the baseline with
`bun scripts/check-test-doubles.ts --update-baseline`, which refuses to raise
any entry.

## 2. Cross-project producers need a captured fixture

A double is a **producer double** when its declared type names an identifier
imported from a module in `PRODUCER_MODULES`: the wrkq ledger
(`packages/hrc-server/src/wrkq/ledger-client.ts`), aspd
(`spaces-aspc-protocol`), or ghostmux. Those types describe another project's
wire. Several of the wrkq ones are `any`, so typing alone proves little.

A producer double that predates the rule is listed in the baseline (key
`uncaptured`) by a hash of its text. Adding a producer double, or changing a
listed one, requires a captured fixture. There is no big-bang recapture.

### Capturing a fixture

1. Make one real call against the real producer: the installed `wrkq` (for
   example `wrkq rpc --stdio` with the method the double fakes), the running
   aspd socket, or `ghostmux`.
2. Save it verbatim under the package's `src/__tests__/fixtures/captured/` as
   JSON:

   ```json
   {
     "producer": "wrkq",
     "producerVersion": "<output of `wrkq version`, or the aspd/ghostmux build>",
     "capturedAt": "2026-10-04T12:00:00Z",
     "request": "<the exact command or JSON-RPC request sent>",
     "response": <the response, unedited>
   }
   ```

3. Tag the double's leading comment with `@captured <path relative to the
   double's file>`:

   ```ts
   /** @captured ./captured/wrkq-room-say.json */
   export class FakeWrkqLedger implements WrkqLedgerClient { … }
   ```

4. Validate the double against it: a test in the same package must read the
   fixture (the check requires its file name to appear in a test file outside
   the `@captured` tag) and assert the double's output has the captured shape.

The check fails if the fixture is missing, is not under `fixtures/captured/`,
names the wrong producer, lacks `producerVersion`, `capturedAt`, `request` or
`response`, or is read by no test.
