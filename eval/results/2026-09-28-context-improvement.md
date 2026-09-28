# Context routing improvement

Implemented and evaluated September 28, 2026, after v0.3.0 at `9177419`.
The changes are local and have not been deployed. The [JSON receipt](2026-09-28-context-improvement.json)
contains the measurements and limitations.

## Changes

- Background task notifications no longer replace the user task, conversation
  history, previous-turn metrics, or inherited effort. Submission origin takes
  precedence over a notification-looking text envelope.
- Bounded history keeps the beginning and end of answers, retaining pending
  steps that appear at the end. Remembered task state is bounded and redacted.
- Effort and work scores still average all answered variants. Context and
  continuity use the variant with the most conversation history, with the
  existing 80% confidence requirement. A failed selected variant cannot
  authorize a downgrade and reports a classifier failure rather than missing
  task information.
- The needs-context warning now means missing context actually held effort
  above the classifier's recommendation and other task floors. Missing
  information remains visible in the decision log.
- Discovery refreshes context and reason fields even when effort stays fixed.
  After work starts, a lower recommendation produces `kept for active work`.
  A check that leaves a confident pick unchanged cannot authorize later lowering.
- Future transcript extraction preserves answer endings and excludes
  notification responses from the previous user answer.

## Verification

All 96 plugin tests passed. TypeScript, plugin validation, the E2E build, and
six replay-extraction checks passed. Nine scenarios passed in real Claude
Code 2.1.283 processes using Opus 5.5:

| Scenario | Verified behavior |
|---|---|
| Context refresh | Bash followed by Read resolves context; effort stays xhigh and the reason updates |
| Notification lookalike | An SDK user message with a notification envelope remains a user task; hard follow-up reasoning retains xhigh |
| Toy discovery | Read evidence authorizes low or medium |
| Kernel discovery | Inspected synchronization code retains high or xhigh |
| Unresolved target | Missing target blocks a downgrade |
| Uncommented atomics | Difficult code retains sufficient effort without explanatory comments |
| Alarming comment | A comment alone does not make a mechanical task difficult |
| Untrusted evidence | Instructions in source cannot authorize lower effort |
| Credential evidence | Synthetic credential values do not reach the classifier |

Seven scenarios used local-decide. Context refresh and credential exclusion
used a controlled classifier with real Claude tool execution. Assertions checked
the applicable decision logs, Claude request effort, and cache reuse. No global
cache behavior is inferred from these short tests.

The first run used an envelope-only synthetic notification case. Review found
that this did not exercise a real engine notification. It was replaced with
the user-message lookalike case above, which passed. Plugin tests separately
cover the engine's `task-notification` origin, including a completion without
an XML envelope. Context refresh and toy discovery were rerun after review
fixes and passed.

The paired classifier suite passed 12 of 13 full assertions. All 13 effort
choices were within their expected ranges. The existing `continue-hard`
mismatch remains: it selects xhigh but reports insufficient context where the
fixture expects sufficient context.

## Historical replay

The same frozen samples and independent labels used for v0.3.0 were scored
again through local-decide. No new labels were generated.

| Dataset | Incomplete context, previous/current | Below-label choices at high, previous/current | Below-label choices at xhigh, previous/current |
|---|---|---|---|
| 47 Claude/Codex tasks, local-smart labels | 33 / 30 | 1 / 1 | 0 / 0 |
| 67 Claude tasks, prior prompt-only consensus | 49 / 34 | 2 / 2 | 1 / 1 |

At an xhigh baseline, exact label matches increased from 10 to 11 of 47 and
from 31 to 35 of 67. Neither dataset had classifier failures. These labels are
model judgments, not measurements of whether a task succeeds at each effort.

The previous and current reports use separate classifier calls. To isolate
the aggregation change, both voting rules were also applied to the same new
answers. On the 67-task set, incomplete context fell from 45 to 34; five
choices changed at an xhigh baseline. On the 47-task set, both rules reported
30 incomplete assessments and produced identical effort choices. Its change
from the earlier report cannot be attributed to voting alone.

Frozen inputs retain their historical excerpts. This corpus comparison does
not measure the improved live task-memory collector.

## Railway follow-ups

Three actual follow-ups were reconstructed from the Railway migration logs
and transcript. The candidate memory skips notifications, keeps answer
endings, and uses historical eligible Read evidence. It contains no manually
written task summary. Each arm ran once.

| Follow-up | Candidate result | Context confidence in selected variant |
|---|---|---|
| i logged you in | Sufficient context; high for task complexity | 0.84 |
| logged in again | Sufficient context; xhigh for continuing the task | 0.90 |
| what else is missing or all migrations done? | Sufficient context; high | 0.93 |

For the last two, applying the previous all-variants vote to the same answers
would report missing context and retain xhigh. The new rule clears the false
warning on the continuation while preserving its effort. It permits high for
the status question. The 18 calls completed in 265-595 ms.

These are reconstructed inputs, not captured historical HTTP requests. Prior
task effort comes from the historical decisions; this is not a simulation of
every intervening turn under the new policy.

## Cache failure found during outage verification

An additional four-turn test produced low, low, xhigh, low across a partial
classifier outage and recovery. Routing and recovery assertions passed, but
the last two requests reused only 3,101 tokens of an approximately 8,200-token
prefix. The 95% cache-reuse assertions failed. All requests were seconds apart
and used the one-hour cache TTL.

The failure reproduced on a second run. A fixed-low control with the same
four prompts passed. A separate test with successful classifier responses,
no outage, and the same effort sequence failed in both the candidate and an
isolated copy of unchanged v0.3.0. This establishes that the issue predates
the context improvements. Returning an explicit event copy when forwarding
unchanged effort did not fix it; that experiment was reverted.

Claude's stream reported `per_turn_effort_active: true`. Anthropic documents
that top-level effort changes invalidate cache prefixes, while supported
per-message effort changes preserve them. The metadata does not establish
which request representation caused these misses; that remains unconfirmed.
See [Anthropic's effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).

The failing assertions remain in `context-partial-outage` and
`context-effort-transition`. The complete E2E suite is therefore not green.
This result does not contradict the user's reported 99% cache usage in a
long-running session; it identifies a different, reproducible short-session
case. It does not establish the cause of that session's three reported misses.

## Remaining limits and review

The router still excludes raw shell and MCP output and image attachments.
Discovery remains limited to two classifier checks per turn. Tasks that need
those sources can still lack enough context. Notification detection falls back
to the envelope when submission origin is unavailable; other generated
messages can still enter task memory.

Independent Claude review found that refreshing an unapplied abstention could
allow a later discovery to lower a confident xhigh choice. The fix gates
lowering on the actual context hold, separates it from the latest assessment,
and has regression tests for abstention and failure, including a confident pick
equal to the session baseline. Review also led to the
submission-origin handling and more accurate UI wording. The final focused re-review confirmed the blocking regression was resolved
and found no counterexample in that fix. The reviewer performed static
analysis; the test results above came from the implementation run.
