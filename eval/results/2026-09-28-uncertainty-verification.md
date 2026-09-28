# Verification of the remaining routing uncertainties

September 28, 2026. The same five Claude Opus investigators continued their
checks on Mac Studio. Runtime tests used Claude Code 2.1.283 and Opus 5.5.
Classifier studies used the configured local-decide endpoint. This report
supersedes the unresolved claims in the [first investigation](2026-09-28-five-opus-investigation.md).

Implementation experiments stayed in isolated copies. The shared candidate
based on `9177419` and the installed production plugin were not changed by these
experiments. The combined prototype is a tested proposal, not a deployed release.
The final independent review found a new unsafe-inheritance regression and a
remaining status defect. Focused comparisons confirmed both findings. The combined
prototype is **not ready to release** despite its passing integration checks.

## Results that change the earlier conclusions

| Area | What the follow-up established |
|---|---|
| Cache | The acknowledgment regression still loses cache on effort changes, but reasoning-task controls do not. The user's exact dashboard sample was identified: all 10 effort transitions before that observation hit. No proxy workaround is validated. |
| Context | Preserving conversation memory helps repeated classifier assessments. The earlier session-root rule incorrectly resets memory within a repository; a Git common-directory prototype corrects the tested cases. Broader collectors and question rewording are not supported as release changes. |
| Effort floor | Both lost-floor paths reproduce in real Opus sessions. Real hook-budget deferral exposes a second path that needs the recovery patch's held-state safeguard as well as the floor fix. |
| Recovery | The real five-minute breaker, shadow behavior, and bounded retries work in the prototype. The stale-label remedy passes its focused checks, but review found a separate missing retry status and an unsafe effort-inheritance regression. Gateway history narrows the original outage evidence. |
| Notifications and resets | Queued delivery can suppress needed effort raises. Reload can lose a turn's record. `/clear` and in-process `/resume` keep stale router memory and log ownership. Experimental remedies have reproduced limitations. |

## 1. Cache reuse and effective effort are separate checks

The initial combined candidate passed 8 of 9 real Opus scenarios. The unchanged
default-path cache regression failed: the two effort transitions read only
3,101 of 8,210 and 8,266 prior-prefix tokens. Fixed-effort and discovery controls
passed. The failing assertion remains intact.

### The user's dashboard sample is now identified

Replaying Claude's cache ledger found a unique match among the eight Studio
sessions with at least 300 requests modified since September 26: session
`040691ea`, at request 394. It has exactly three misses, 914,055 re-cached tokens,
and a 98.89% hit ratio. **All 10 effort transitions before that observation hit.**
All three misses kept xhigh effort. Two followed gaps longer than one hour;
the earlier partial miss followed 376 seconds and its cause remains unknown.
This supports the user's observation for that session. Thread use cannot be
reconstructed conclusively from its transcript.

### The synthetic cache regression depends on the response history

In the tested matrix, the miss appeared when a request ended in a cache-marked
system segment and received a text-only answer. With thinking in the first
answer, the next stateless request reused the prefix in 2/2 controls. Across
the separate reasoning-effort experiment, all 60 follow-up requests hit,
including default-path effort transitions. Thus the acknowledgment regression
does not show that every effort change loses cache.

Removing `output_config`, changing markers, and normalizing strings to blocks
did not remove the conditional miss. A later create also differed by path:
direct defaults missed in 8/9 runs, while proxied requests hit in 8/8.
Delay, gzip, and connection controls did not isolate its cause. Server rendering
and cache placement remain unobservable.

The proxy experiment requires both cache reuse and correct application of
the requested effort. None of the 62 inspected responses exposed server-applied
effort. Lowering produced thinking-token counts consistent with low in three
repetitions; raising remained inconclusive. History also reduced thinking-token
use after a raise on the default path. The proxy's pinned top-level effort
caused a later fingerprint rejection and replay before its conversion succeeded.
It therefore remains an experiment, not a validated production workaround.

The measured behavior belongs to one account's current rollout and runtime.
Current flags were recorded; their historical values are unavailable.

### Idle control

The stabilized idle control used fixed medium effort and no router. Requests
2 through 4 reused the warm prefix. After 301 seconds idle, the server returned
`thread_not_found`, Claude retried with a full-history `create`, and only
3,099 of 8,344 prior-prefix tokens were reused. The immediate repeat was warm.
This establishes that the same loss can occur without routing. It does not
establish the prompt-cache TTL. The earlier outage test also changed effort,
so its miss cannot be attributed exclusively to either cause.

Evidence: [cache report and experiment matrix](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/cache/results.md),
[matched dashboard ledger](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/cache/dashboard-session-040691ea.json).

## 2. Context: preserve memory, and qualify classifier confidence

Across 29 historical turns whose inputs differed, three paired repetitions
gave 18 sufficient-context assessments for the candidate and 31 for the
continuity prototype, out of 87 per arm. Mean sufficient-context probability
increased by 0.216; a bootstrap interval was 0.109 to 0.328. At an xhigh baseline,
routed effort barely changed. These are classifier judgments, not task outcomes.

The fresh collector studies did not support broader evidence collection:

- Strict Bash collector: 11 changed tasks, four repetitions, sufficient
  assessments 7/44 versus 8/44. The estimated confidence gain's interval
  includes zero. Bash reads also displaced useful Read/Grep evidence in one task.
- Richer project files: 38 turns, three repetitions, sufficient assessments
  decreased from 52/114 to 47/114. Railway showed no benefit.
- Rewording the context question improved sufficiency, but below-label choices
  increased from 1 to 6 of 134 on the older regression set. Those labels also
  have disagreement; the result does not establish a safe replacement question.

The earlier claim that all three Railway follow-ups became sufficient did not
repeat. Identical inputs also changed in mean confidence by up to 0.187 between
time windows. Concurrent versus sequential calls did not explain that drift.
Paired arms within a window are more useful than comparing absolute rates from
different runs. Its server-side cause remains unobserved.

### Corrected project identity

`session.root()` changes on worktree entry/exit and on interactive `/cd` into a
subdirectory. `session.repo()` follows shell cwd, so substituting it would
reintroduce resets on ordinary shell navigation. The revised prototype finds
Git's common directory from the **session root** instead.

It passed live worktree entry/exit, shell navigation into nested repositories,
and interactive navigation within and across projects. Real Git layout checks
covered ordinary, relative, separate-git-directory, bare-repository worktrees,
submodules, and non-repository directories. Symlinked roots are not normalized;
environment-based Git overrides and unusual indirection remain outside the
tested contract.

Review also raised possible error-log noise from probing `.git` with a read.
Inspection of the real Git runtime logs confirms four `EISDIR` error entries
across three scenarios. Identity still resolves correctly in those runs.
The implementation should check the path type before reading it.

Keeping the latest notification reply separate from the original task also
passed real continuation and independent-task checks. The independent task
could select low without inheriting the prior task's floor.

Evidence: [context report](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/context/FINDINGS.md).

## 3. Floor protection: runtime and task outcomes

Twenty headless runs confirmed the lost-floor sequences and their controls.
Eleven interactive runs forced real hook-budget deferral. The floor fix preserves
an earlier confident high choice. After an initial failure, deferral still
allowed low unless the recovery patch's held-state safeguard was also present.
Real wall-clock tests cover the default five-second classifier timeout; the
interactive deferral tests used the supported eight-second timeout.

The quality study used executable oracles with the router disabled:

| Fixture | Initial low | Initial high | Initial xhigh | Fixed follow-up |
|---|---:|---:|---:|---|
| Mechanical counter edit | 3/3 | 3/3 | 3/3 | None |
| Specified pthread fix | 4/4 | 4/4 | 4/4 | None |
| Enumerate concurrent outcomes | 3/5 | 5/5 | 5/5 | Low 9/10; high 10/10 |

All three failures were incorrect low-effort enumerations. There were 56 first
attempts and no retries. The follow-up was chosen after the initial difference
appeared. These small fixtures establish concrete failures, not general failure
rates, performance on the 47 historical tasks, or the effects of switching effort
mid-turn. Production frequency of intermediate budget deferrals remains unknown
because existing logs omit the required timing.

Evidence: [floor report and oracle details](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/floor/REPORT.md).

## 4. Recovery and historical outage evidence

The real breaker test completed five turns in one Opus process and passed all
14 assertions. Three timeouts opened the breaker. Read evidence collected while
paused survived. The first model request after expiry retried against live
local-decide at about 310 seconds, recovered, and preserved the active effort floor.

With a four-second classifier delay, shadow mode sent the model request without
waiting and preserved medium effort. Enforce mode waited about four seconds and
then sent xhigh. Focused tests cover overlapping calls, late results after a
reset event, manual effort, retry limits, and completion while a shadow retry is
pending. They do not substitute for real `/clear` behavior.

The status remedy distinguishes service health from the turn's unanswered
assessment. A successful mid-turn message enables the next bounded retry;
it cannot authorize lowering after work. The UI comparison showed the pending
retry in the spinner and status command. The capped extra retry is verified in
the test kit. Timer callbacks also worked in a bounded real probe, but the
recommended design continues to retry on model requests.

### Correction to the long Railway turn

The earlier "28-minute" duration was Claude's reported active duration. The
transcript spans about 90 minutes of wall time, ending at 13:14:51 UTC.

The additional metadata-only gateway board shows **259 of 259 requests failed
between 12:55 and 13:15 UTC**. Engine processing resumes in the 13:15–13:20
bucket. This turn does not demonstrate missed recovery. The separate
245-second, 19-request case still does: other sessions successfully classified
during that affected turn.

The five-minute buckets do not reveal the exact recovery instant or exclude
brief availability between observed requests. No SSH or configuration changes
were needed to read this evidence.

Evidence: [recovery report](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/recovery/REPORT.md),
[additional gateway history](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/infrastructure/REPORT.md).

## 5. Notification delivery and session lifecycle

Real Opus requests confirmed that `wait: true` does not guarantee delivery as a
separate turn. A hard-first batch can enter the model while `turn.start.text`
contains only the final simple request. Both cases can miss a needed raise.
The experimental batch remedy addresses those raises in 3/3 real arms. It also
over-raised a simple next turn after the hard submission had already been
delivered into the previous turn. Task memory still contains only the final
prompt. The host exposes neither stable submission identifiers nor a complete
mapping from submissions to turns. One existing contract test fails (97/98
pass). This remedy is excluded from the combined candidate.

### Confirmed lifecycle defects

| Operation | Observed behavior | Router consequence |
|---|---|---|
| Reload at a queued-turn boundary | The old instance receives `turn.start` and the first step; the new instance receives completion | The record is lost in 5/5 runs, including two without instrumentation. A later step can lose its decision and drop xhigh to low. |
| `/clear` | Session ID changes without `session.start` | The router retains the cleared task's memory and writes to the old log. |
| In-process `/resume` | Session ID changes without `session.start` | The router retains memory and log ownership from the conversation being left. |
| New-process `--resume` | `session.start` fires with the resumed ID | The router appends to the correct log but starts with empty task memory. |

The reload persistence prototype uses `$.state` plus per-turn adoption and
session-ID checks. It preserved records and effort in the tested reload cases
and started a fresh log after `/clear`. That state is discarded on conversation
switches and process restarts, so it cannot restore resumed task memory.
Its real stale-writer race remains unverified, and its unit fixture does not
exercise the persistence branch. The diff also contains tracing code.
It is excluded from the combined candidate.

A separate apparent reset race occurred only when the tracer awaited before
resetting memory; removing that await removed the observation. It is recorded
as instrumentation interference, not a production finding. The original
notification-envelope fallback was never needed in 20 real module reloads;
SDK queues and other plugins' rewrites remain untested.

Evidence: [notification and lifecycle report](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/notifications/REPORT.md).

## Integration and evaluation limits

The final isolated combination includes the floor, strict recovery and held
safeguard, submission-origin fix, latest-reply memory, corrected Git identity,
and stale-label remedy.

- **151 plugin tests pass**, including three real wall-clock budget tests.
- Typechecking, replay checks, build, and explicit plugin-and-hook validation pass.
- **5/5 final real Opus checks pass**: directory continuity, summary refresh,
  notification lookalike, kernel discovery, and untrusted evidence.
- The earlier 8/9 integrated run retains its failing default cache regression.

`claude plugin validate .` checks the marketplace manifest in this repository.
The explicit `.claude-plugin/plugin.json` path is needed to validate the plugin
manifest and trace its hooks. Existing README/CI validation instructions need
that correction before release.

The replay checks pass their current contract, but two focused reproductions
show that contract is incomplete: extraction drops notification replies now
used by the live prototype, and `routingVersion()` omits `register.ts`, where
memory behavior lives. Historical scores therefore do not establish parity
with the revised live router. The input simulators and frozen datasets used
by each study are identified in the context report.

Artifacts: [combined diff](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/integration-followup/combined-prototype.diff),
[verification receipt](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/integration-followup/summary.json),
[replay defects](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/integration/replay-parity.json).

## Independent review and preserved reproductions

A headless Opus 5.5 review inspected the combined diff after local and runtime
verification. Its verdict was **not ready as submitted**. Three focused tests
then reproduced the findings in separate baseline and candidate copies:

| Finding | Baseline | Combined prototype | Disposition |
|---|---|---|---|
| Manual low turn fails classification, then an automatic empty-text turn starts at xhigh | Sends low, then xhigh | Sends low, then low | New unsafe inheritance: `turn.complete` remembers the manual step's sent effort as an automatic choice |
| Failed automatic turn's last step yields to another source's low effort, then an empty-text turn starts at xhigh | Sends xhigh, low, xhigh | Sends xhigh, low, low | Same regression through a yielded step |
| Discovery failures exhaust the budget while recovery remains pending | No recovery path | Retry still happens after cooldown, but spinner and status omit the pending assessment | New status line uses a reason prefix instead of recovery state; the spinner omission predates this change |

All six characterization checks passed, meaning they confirmed those behaviors;
they are not passing assertions of desired behavior. The implementation was
left unchanged, and these tests are separate from the 151 integration tests.
Future fixes must prevent manual/yielded values from becoming automatic picks
and render pending recovery independently of the display reason.

The review also confirmed a documentation gap: notification replies now supply
up to 1,000 redacted characters as `previous_answer`. A reply can restate shell
output even though raw shell output is excluded from collection. The README
must describe that data flow and the new recovery/status behavior before adoption.
This is part of the proposed continuity behavior already tested, not a newly
deployed flow. The existing outage path can also overwrite an original task's
identity with a failed `Continue` request; preserving effort alone does not
preserve that identity.

The review's stated lack of real Git-engine evidence reflected the integrated
E2E folder it inspected. Dedicated Git runtime evidence exists in the context
track; reinspection confirmed both functional identity and the error-log noise
described above. Review statements about synthetic reset guards do not establish
correct `/clear` handling; the real lifecycle tests demonstrate the defect.

Evidence: [independent review](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/integration-followup/review-result.json),
[candidate reproductions](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/review-reproductions/candidate.log),
[baseline controls](/Users/macstudio/.local/state/effort-router/2026-09-28-uncertainty-verification/review-reproductions/baseline.log).

## What remains uncertain

The follow-up resolves the local reproductions above. These limits remain;
none is covered by the passing integration counts.

| Question | Evidence obtained | What would settle it |
|---|---|---|
| Does the proxy reliably apply raised effort? | Matched thinking-token probes remain inconclusive; no applied-effort field in responses | An authoritative host/server contract or diagnostic, plus a corrected implementation and repeated behavior checks |
| Why do direct and proxied creates differ? | Several transport controls and prefix hashes; no isolated cause | Server cache/rendering diagnostics or an observable direct request body |
| What caused the dashboard's first partial miss? | Same effort, 376-second gap, partial cache reuse | Historical server diagnostics unavailable in the transcript |
| Why does local-decide confidence drift? | Identical payloads shift across time windows; within-window paired evidence remains useful | Backend model, batching, and sampling telemetry tied to those calls |
| Do omitted context sources improve task outcomes? | Broader collectors and rewording lack a safe regression result | A stronger labeled set and task-success evaluation before adoption |
| How frequent are floor-loss and budget-deferral paths in production? | Reproductions and bounded fixtures; logs omit intermediate timing | Instrumentation that records deferrals and sufficient-decision floors |
| Can batch delivery be classified exactly? | Both missed raises and an over-raise reproduced | Stable submission-to-delivery identity from the host, or an explicitly conservative product policy |
| Can all reload and resume states be restored safely? | Hot-reload prototype works in tested cases; state disappears on conversation/process changes | A persistence design, provenance-aware reconstruction, and tests for shadow completion and stale writers |
| Does project identity cover every Git layout? | Common-directory checks cover the listed real layouts | Symlink normalization and explicit support/tests for environment overrides if those are required |

The exact gateway restoration instant remains bounded to a five-minute bucket.
Runtime evidence comes from one account, host, and Claude Code version; current
rollout flags do not establish behavior on other accounts or future versions.
