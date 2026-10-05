# Maintain: the upkeep pass

The pass that keeps this skill true as HRC changes, at least every 14 days (fitkit `verify-upkeep@2` goes
stale after 14). A schedule files it as an upkeep task in project hrc-runtime and dispatches an agent that
composes this skill; anyone can run it by hand the same way. Adapted from Foundry's
`spaces/verify-foundry/skills/verify-foundry/MAINTAIN.md`.

**Edit scope:** this skill directory (the feature files, SKILL.md, this file, `hv`). No product code. A product
defect becomes an hrc-runtime task.

**The last pass** is the newest `verify.upkeep` fact's `head` (`wrkp log hrc-runtime --type verify.upkeep
--limit 1 --json`), or, when there is none, the skill's first commit (`git log --reverse --format=%H --
spaces/verify-hrc-runtime | head -1`). Every "since the last pass" below means `<that sha>..HEAD`.

**Evidence** goes under the pass task's `artifact_dir` (`~/praesidium/var/wrkq-artifacts/<task>/`), laid out as
[SKILL.md](SKILL.md) "Evidence" says: `index/` (step 1), `sources/NN.md` (step 2), `plan.md` (step 3), one
`NN-<feature>/drive.txt` per feature (step 4), `evidence/<scratch name>/` from each `hv evidence`, and
`ship.txt` (step 6).

**Never** in a pass: `just install`, `just publish`, `just deploy-*`, `hrc server restart|stop`,
`release gc|sweep --apply`, `federation retire`. A drive that needs one is written down as `needs operator`.

## 1. Index hygiene

`features/README.md` against `features/*.md`: every file is linked, every link resolves, and each row's
summary still names what the file covers. Each feature file has the five H2s (Sub-features, How to get to
it, Driving it, Gotchas, Proven when) and SKILL.md has Launch, Doctor, Drive, Evidence, Cleanup, Helpers.
Every non-markdown file in this directory is mode 100755 in git (`git ls-files -s
spaces/verify-hrc-runtime`) and named in SKILL.md. Then compare the live surface with the map:
`hrc --human --help`, `hrc admin --help` and each group's `--help` against the verbs the feature files name.
A verb no file names is mapped in step 6 or listed under the README's "Not mapped here" with why. Save what you
ran to `index/`.

## 2. Source reads, one per feature

For each feature file, read the code it names and `git log <last pass>..HEAD -- <those paths>`, and answer:
what does the code do now, and which Sub-features, Gotchas or Proven-when lines are likely drift? Flag any
behavior the file doesn't state. Cite file:line. Fan these out as read-only subagents when the session can,
or read them one after another. Write one note per feature: `<artifact_dir>/sources/NN.md`.

## 3. Reconcile

Merge the source notes into a plan that drives every feature in as few scratches as practical (one
`hv scratch up --name <task>` serves features 2, 3, 4, 7 and 8; features 1, 5 and 6 add live reads). List each
feature's drive and the suspected drift and new behaviors it has to confirm or clear. Write it to
`<artifact_dir>/plan.md`.

## 4. Live pass over every feature

Drive every feature (eight today) on every pass, even when no HRC commit landed since the last pass: drift
also comes from what HRC runs on (ASP and aspd, the harness CLIs, tmux, wrkq), which the source reads don't
see.

Run `hrc doctor` and `hrc server status` first, and again after any surprise. Note the installed
`sourceCommit`: the pass grades that build, which may lag HEAD. Drive each feature's "Driving it" **and
every drift or new behavior step 2 flagged**, recording with `hv rec`. Check each result against "Proven
when". Run `hv evidence <name> <artifact_dir>/evidence/<name>` before `hv scratch down <name>`, and confirm no
process still names `/tmp/hv/<name>`. Count the features you drove to their Proven when (`driven`), and name
any you couldn't drive with the prerequisite that stopped you. Feature 6's install leg is operator-only by
design; its read-only drive counts as driven.

## 5. Triage every failure

| Class | Meaning | Action |
| --- | --- | --- |
| Doc drift | The build is right; the file is stale | Fix the feature file (Gotchas with date and evidence) |
| Harness gap | `hv` or this skill can't reach or observe it | Fix `hv` or SKILL.md |
| Product gap | The build is wrong | File a task under `hrc-runtime/inbox` with the failing drive; never paper over it in the map |

## 6. Ship

Make at most one commit of the proven map and harness fixes, with each fix re-driven. Commit by explicit
paths with a private index and push per the repo's shared-checkout conventions; keep the commit and push
output in `ship.txt`. On the pass task, comment the outcome and coverage:

- `clean`: nothing changed;
- `changed`: the commit SHA and what moved;
- `blocked`: what stopped the pass and the task that tracks it.

Add `driven/features`, the evidence path, any product tasks filed, and a **source-only, undriven** list: each
finding from step 2 that went into the map without a drive behind it, with why it wasn't driven.

## 7. Post the fact

End every pass by posting `verify.upkeep`, including a blocked one and a pass that stopped early. Its
attributes are the `consumes` block of fitkit's `verify-upkeep@2` (`foundry direct fitkit.catalog '{}'` from
`~/praesidium/foundry`). `features` is the count of `features/*.md` other than README.md; `head` is
`git rev-parse HEAD` after the ship. Post it last, after the task comment, so its `occurred_at` is the pass's
finish time:

```bash
wrkp post hrc-runtime --type verify.upkeep --key verify-upkeep:<task> -m "verify-hrc-runtime upkeep <task>: <outcome>" \
  --attr outcome=<clean|changed|blocked> --attr features=<n> --attr driven=<n> --attr head=<sha> --attr task=<task>
```

The key makes a repeated post one fact. Then complete the task (or leave it open only when it is blocked, and
say on what).
