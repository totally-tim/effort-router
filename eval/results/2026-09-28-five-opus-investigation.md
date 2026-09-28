# Five-agent investigation of effort routing

Investigated September 28, 2026, against the uncommitted candidate after
v0.3.0 (`9177419`). Five Claude Opus 5.5 investigators ran in parallel on
Mac Studio, one per issue. Experimental changes stayed in isolated copies.
This investigation adds this report; it does not apply or deploy those fixes.

## Findings and proposed changes

| Issue | Confirmed finding | Proposed change and verification |
|---|---|---|
| 1. Cache loss | In Claude Code 2.1.283 with Opus 5.5, changing effort changes the Message Threads fingerprint and causes a new thread with the full history. The first such transition repeatedly lost the message cache. | Requires work on Claude's request handling. A controlled proxy experiment preserved caching, but did not establish that the requested effort took effect. No production workaround is validated. |
| 2. Missing context | A shell `cd` clears task memory. The candidate also omits assistant replies to notifications, even when the user answers those replies. Shell file reads remain invisible. | Preserve memory while the session's project root stays the same, and keep the latest visible reply separately from task identity. That prototype passes 98 tests and a real Claude directory-change check. Hold the Bash collector pending stronger evidence. |
| 3. Lost effort floor | A confident high choice can become low after an intervening missing-context hold or failed check. Both v0.3.0 and the candidate reproduce it. | Preserve the highest sufficient-context choice within the turn. The prototype passes 114 tests, including 18 focused cases. |
| 4. Outage recovery | A long-running turn can remain unclassified after the service returns. Paused checks also consume discovery opportunities without making requests. | Retry on later model requests, with a time interval and attempt limit. Combined with the floor fix, the prototype passes 125 tests and recovers in a real Claude session. Some stale status labels remain. |
| 5. Notification handling | A notification-looking user message typed during a final answer can lose its origin and disappear from task memory. Queued batches and plugin reloads expose further gaps. | Record every submission and match the newest exact text. The prototype passes 98 tests and real interactive memory checks. Batch completeness and reload recovery remain open. |

## 1. Cache loss comes from the thread/request path

The installed Claude Code uses the routed effort for the top-level
`output_config.effort`, a per-turn system message, and the Message Threads
fingerprint. A change causes a `create` request with full history, instead of
a `continue` request with new messages only. The server also checks the
top-level configuration: changing it on a forced continuation produced
`thread_fingerprint_mismatch`.

In a direct low, low, xhigh, low run, the two transitions read only 3,100
cached tokens from prefixes of 8,209 and 8,265 tokens. In a repeat, the first
transition missed and the second hit. Fixed-low controls stayed warm.
Disabling Message Threads in the test process preserved both transitions,
but exposed a separate one-time miss on the second request, also present at
fixed effort.

A proxy experiment kept top-level effort fixed and continued the thread,
while carrying changes in per-turn messages. Both transitions reused the
cache. These acknowledgment prompts produced no thinking tokens, so this
experiment does not verify effective reasoning effort. The undocumented
`CLAUDE_CODE_TETHER_LIVE` switch is a diagnostic control, not a release fix.

The server's reason for the full-history prefix mismatch remains unknown.
An extra cache breakpoint located a separate mismatch at an unchanged system
message that had previously been last in the request. Normalizing its JSON
representation did not fix it. Public documentation describes a different
per-message effort beta; it does not establish the behavior of this internal
thread path. See [Anthropic's effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation).

Keep the default-path failing cache regression visible. Diagnostic controls
should have separate assertions. The user's reported 99% cache usage in a
long session remains compatible with these results; the cause of that
session's three misses was not established.

Evidence: [cache report](/Users/macstudio/.local/state/effort-router/2026-09-28-five-opus/cache/results.md).

## 2. Preserve the conversation before adding more tool output

`decide()` clears history, the previous task, and inherited effort whenever
`session.cwd()` changes. A real Claude run confirmed that Bash `cd` changes
this value while `session.root()` stays fixed. The following user request
then reaches the classifier without the preceding task. Eight of 22
insufficient-context Railway turns in the joined sample followed such a
reset. This is a confirmed contributor; the sample does not explain every
warning.

The candidate also discards assistant replies to background notifications.
Nineteen of 36 Railway user prompts followed such a reply. Keeping the latest
visible reply as `previous_answer`, while retaining the original task's
request, answer, and effort, improved sufficient assessments from 17 to 22
across 57 repeated assessments per arm. Those are classifier judgments,
not measured task success.

The recommended prototype contains these two continuity changes. It passes
98 plugin tests, TypeScript, and the real `cwd-continuity` scenario. It
refreshes the repository summary after `cd` and resets task memory when the
session's project root changes.

The proposed Bash collector did not survive review as a recommended change.
Its first version accepted counts, paths, and diff statistics as target
evidence. Focused tests reproduced this. The stricter version rejects those
forms, but its remaining nine changed tasks showed no new sufficient-context
assessments and no effort changes in the repeated replay. Its initial apparent
gain came partly from statistics output. Keep the collector experimental.

Identical local-decide inputs varied by as much as 0.27 in context confidence
between runs. Single-run improvements, including the earlier three-case
Railway replay, need that qualification.

Evidence: [context findings and patch paths](/Users/macstudio/.local/state/effort-router/2026-09-28-five-opus/context/FINDINGS.md).

## 3. Retain a confident minimum through a temporary hold

With an xhigh session baseline, both versions reproduced this sequence:

1. A sufficient-context decision selects high.
2. A missing-context discovery or failed check raises the turn to xhigh.
3. A sufficient low discovery releases the hold and selects low.

The earlier high choice has been overwritten. Without the intervening hold,
the same later low recommendation cannot lower high. The defect also affects
tool-error escalation and the level inherited by a continuing task.

The prototype records the highest sufficient-context decision within each
turn. A released hold cannot go below that level. Six regression cases fail
on the candidate and pass with the fix; 12 counterexamples preserve existing
behavior. The full scratch suite passes 114 tests. No live task-success test
was run, and the exact defective sequence was absent from the 204 historical
turn records examined.

Evidence: [floor report and reproduction logs](/Users/macstudio/.local/state/effort-router/2026-09-28-five-opus/floor/REPORT.md).

## 4. Retry on a later model request and distinguish health from history

The current router waits for a new prompt or eligible Read/Grep evidence.
A paused discovery sends no request but consumes a check and marks its
evidence checked. A turn can exhaust both discovery opportunities during an
outage.

Historical evidence includes a 245-second turn with 19 requests that stayed
at fallback while other sessions received successful classifier responses.
A separate 28-minute, 79-request Railway turn also stayed at fallback, but
the logs do not establish whether the service recovered during that turn.

The prototype retries on a later `turn.step`, at least 60 seconds after a
failed attempt, with at most three retries per turn and respect for the
five-minute breaker. A paused check spends no discovery budget. Recovery can
raise effort; failure alone does not authorize lowering.

In real Opus 5.5 sessions with a controlled classifier, the candidate made
one failed request and stayed at medium. The fixed and combined copies
retried after 67 and 68 seconds, then sent xhigh. No new file evidence was
needed. The real five-minute cooldown was not rerun; focused fake-clock
tests cover that path.

Combine this with the floor fix. Recovery alone fails a new case where
preserved discovery opportunities expose the earlier lost-floor defect.
The combined suite passes 125 tests.

Review found two remaining status problems in the prototype. A successful
mid-turn message can make classifier health OK and raise effort while the
spinner still reports the earlier HTTP failure. Before the retry deadline,
the next eligible recovery clears it. After all retries are exhausted, it
can remain for the rest of the turn. Two focused tests confirm this; proposed
remedies are documented but unimplemented.

Evidence: [recovery report, dependency, and remaining limits](/Users/macstudio/.local/state/effort-router/2026-09-28-five-opus/recovery/REPORT.md).

## 5. Submission time does not determine delivery time

Interactive Claude can accept plain Enter during a running turn, then deliver
that message as its own turn after the final answer. The candidate records
only idle or explicitly queued submissions. It therefore loses this message's
origin and falls back to text matching. A user message with a notification
envelope is incorrectly excluded from task memory.

The real reproduction confirmed the consequence: a subsequent `Continue.`
referred to the earlier essay instead of the user's intervening message.
Recording every submission and selecting the newest matching text fixed
that sequence. Two new regression tests fail on the candidate and pass with
the fix. Its full suite passes 98 tests, with typecheck and plugin validation.
The final fix also passed real interactive memory and batched idle delivery
checks. Notification runtime tests used Sonnet 5 on the same Claude Code
2.1.283 host; the investigator itself ran Opus 5.5.

Further confirmed host behavior needs separate work:

- A queued message can enter the running turn even with `wait: true`; the
  current mid-turn classifier skips it.
- A queued batch can contain several user messages while `turn.start.text`
  contains only the last. Classification then misses earlier requests.
- One reload landed between a queued turn's start and its first model step.
  The turn completed without a router decision record. The exact reset race
  is unconfirmed, and reload state preservation is unimplemented.

Use the context investigator's project-root rule when combining memory
changes. Clearing notification memory on every shell directory change would
reintroduce the confirmed continuity defect.

Evidence: [notification report and event traces](/Users/macstudio/.local/state/effort-router/2026-09-28-five-opus/notifications/REPORT.md).

## Scope and next implementation order

Apply and review the floor, origin, and continuity fixes first. Then integrate
bounded recovery with the floor protection and resolve its remaining status
cases. The queued-message and reload gaps need their own focused changes.
Keep cache work separate until a solution verifies both cache reuse and
effective effort. Keep the Bash collector experimental.

Only the floor and recovery prototypes were tested together. The four
recommended router changes have not been integrated or evaluated as one
release. The production plugin remains v0.3.0.

Private scripts, traces, patches, and the dispatch hashes are under
`~/.local/state/effort-router/2026-09-28-five-opus/`. Three investigators used
one built-in Fable advisor call before coordination stopped further calls;
the cache investigator's advisor attempt returned no result. No additional
investigative agents were launched. Direct TLS interception was rejected by
the investigator's permission review; accepted proxy experiments and direct
controls supplied the reported evidence.
