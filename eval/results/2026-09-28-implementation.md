# Effort-router implementation and evaluation

Implemented September 28, 2026, after the five-agent investigation and uncertainty verification. Five Claude Opus 5.5 agents worked in parallel on isolated worktrees on Mac Studio. The combined implementation was checked separately against the task-start checkout.

## Design choices

Keep task identity and evidence in the Claude hook layer, where the router can observe actual submissions, delivered messages, tools, and session boundaries. The classifier still receives bounded context and can decline to justify a lower effort. A timeout and insufficient context require different handling: retry an unanswered decision after recovery, and reassess missing context when new evidence arrives.

The earlier experiments did not justify collecting arbitrary shell output or loosening the context threshold. Both could make warnings disappear without showing that a lower effort is safe. The cache experiments also did not validate a transport workaround that both preserves cache and proves the requested reasoning effort. The implementation therefore retains conservative routing and makes the observed cache failures explicit.

## Changes

| Area | Implementation |
|---|---|
| Context continuity | Shared live and replay task-memory functions retain the original task while using the latest visible reply. Shell directory changes and Git worktrees preserve memory within one project. Real paths identify symlinked repositories without reading `.git` directories as files. |
| Effort protection | A sufficient-context decision establishes a minimum for the rest of the task. Temporary uncertainty or failures cannot erase it. Manual effort and another hook's temporary override do not become automatic inherited choices. |
| Outage recovery | Later model requests retry unanswered decisions with waits of 1, 2, 4, then at most 5 minutes. Retries respect the circuit breaker, remain single-flight, and cannot lower effort. Paused checks preserve discovery opportunities. Status distinguishes endpoint health from the running task's unanswered assessment. |
| Prompt delivery | The router retains submission origins, joins confirmed queued prompts into one task, and includes delivered messages in task memory. Exact observed wrapper matching prevents quotes and framing text from consuming pending prompts. Unknown delivery falls back conservatively. |
| Session lifecycle | Conversation IDs scope memory, logs, and asynchronous callbacks. Host-held state transfers a running turn across reloads. Bounded, redacted checkpoints restore resumed tasks. Separate writer files preserve concurrent histories; ambiguous branches hold starting effort. |
| Cache diagnostics | Decision logs and status show observed misses after effort changes and misses on other requests. The E2E runner distinguishes verified routing behavior from the reproduced host cache pattern and keeps a nonzero exit for those cache failures. |
| Evaluation | Replay uses the live memory helpers and records missing provenance. Codex turn boundaries group commands with skill expansions and exclude known host messages. Fingerprints cover every live routing module. |

## Verification

The final implementation passed 270 plugin tests, TypeScript, and strict plugin validation. The preceding candidate passed 22 replay checks and the E2E runner build; its replay code is unchanged in the final implementation. Validation traced the session-state declarations and the new delivery handler. The resume-ordering regression fails without the restore guard and passes with it. Unicode log rotation counts UTF-8 bytes.

The complete Claude Code 2.1.283 / Opus 5.5 E2E suite on `final-snapshot3` completed with 28 passes, zero other failures, two known cache failures, and no skipped scenarios. All routing assertions passed. Exit code 3 preserves the failing cache gate. The real outage scenario waited through the five-minute cooldown in the same Claude process and recovered against live local-decide. The reasoning-based cache control passed.

All ten native queue scenarios passed 54 assertions against `final-snapshot3`. The driver required a successful exit, exactly the requested scenario set, complete run records, and one inline router module. It checked hard-first and hard-last batches, mid-turn delivery, canceled prompts, retained task identity, and typed notification lookalikes against Claude's actual request efforts.

An independent headless Opus 5.5 review found five additional defects. It reproduced a failed-discovery effort inheritance regression, two submission/restore races, and the permanent loss of restore after 64 checkpoint files. It also identified a takeover retry that conflicts with the host's per-dispatch state snapshot contract. The fixes preserve inherited effort on unanswered discovery, defer prompt matching until restore completes, merge submissions received during restore, and restore any number of consistent checkpoint files. Transfer retries now read a later host state snapshot before trying again.

A second independent review found three defects in how repeated transfer conflicts composed: a later merge could overwrite locally completed work or a mode change; stale memory could authorize effort below the session level; and a failed transfer could prevent new checkpoints, making a later resume restore obsolete memory. The corrections keep local changes through repeated merges, hold typed and empty turns at least at session effort while memory remains uncertain, and keep writing this instance's checkpoint unless another writer has taken ownership. New regression tests fail on the earlier implementation. Late merged prompts enter task memory only when the first request's transcript proves delivery; canceled, absent, duplicate, or rewritten submissions do not become remembered tasks.

The third independent review confirmed those corrections and found two low-severity regressions in the completion rule. It could restore a low inherited value after a manual turn, or carry an earlier xhigh level through every later task after a refused transfer. The reviewer tested a three-line correction: capture the inherited level seen at decision time, and preserve a higher level at completion only if a merge changed it and the turn has an inheritable value. That exact behavioral correction is in `final-snapshot4`. Both defect tests fail on `final-snapshot3` and pass after the change. Four retained cases also cover command identity through repeated merges and a control without a reload. All 270 plugin tests pass.

Four focused real-Claude checks passed on `final-snapshot4`: manual launch effort, real task continuation, context refresh, and shadow mode. None failed or skipped, and the runner exited 0.

The full native and 30-scenario runs preceded this last correction. The correction affects completion after a missed transfer; native tests did not produce that contention, so its direct evidence is the before/after harness tests and the reviewer's independent test of the patch.

The reviews used no advisors or subagents. The test-driver audit found no advisor calls in the 30 E2E sessions or ten native queue sessions. A separate real Claude smoke test passed with the server advisor explicitly disabled.

All eight native lifecycle scenarios passed 135 assertions on `final-snapshot3`: clear, resume in the same process, resume in a new process, idle reload, two queued-turn reloads, reload after a directory change, and competing checkpoint branches. The queued reloads occurred 22 ms and 11 ms after turn start, before completion. Both passed the strict timing precondition on their first attempt. The tests checked actual effort, retained memory, one record per completed turn, and isolation between conversations.

No native run produced a contended memory transfer. The compare-and-set conflict, delayed-read, and repeated-merge paths are verified by deterministic tests of the host state contract. Native reload tests verify the actual hook boundaries but cannot establish the frequency of those races in use.

### Historical local-decide comparison

The frozen datasets contain 47 and 67 labeled records from Claude and Codex usage logs. One record containing only host-generated text is excluded. Of the 113 matched records, 78 have changed classifier request bodies. Those 78 records were evaluated three times per version, with the two versions interleaved in one time window. There were no failed assessments.

| Changed records | Sufficient context, before / after | Picks below labels at xhigh baseline, before / after | Mean change in sufficient-context confidence, with 95% interval |
|---|---|---|---|
| 28 from the 47-record set, 84 assessments per version | 33 / 36 | 0 / 0 | -0.008, interval -0.054 to +0.034 |
| 50 from the 67-record set, 150 assessments per version | 44 / 54 | 2 / 1 | +0.041, interval -0.011 to +0.100 |

Across both sets, sufficient-context assessments increased from 77 to 90 of 234. Picks below the existing labels decreased from 2 to 1 at an xhigh baseline, and from 10 to 4 at a high baseline. Overall xhigh use at the xhigh baseline was nearly unchanged, 169 to 170 of 234. The intervals include no improvement; this result does not establish a general confidence gain or cost savings. The intervals resample records, and records from one session can be related.

The before tree is the actual task-start checkout, not the evaluator's older prompt format. The scored candidate routing fingerprint is `8ea7860c959bc20f`. The final implementation fingerprint is `876ff18b5b51e50a`; `final4-eval/prepare.json` confirms that every classifier request body is unchanged from the scored run (zero records need new calls in either dataset). The extractor fingerprint is `fdfcfc416d1d8604`. The historical scores are reused with that body-equality evidence; they are not a second model run. Frozen samples and labels were preserved. Inputs, responses, and per-record comparisons are in `final-eval/`.

## What remains limited

A failed transfer of memory between plugin instances has a separate recovery path from a classifier outage. The router makes at most four transfer attempts, waiting at most one second within each decision. If the host remains unavailable or the attempts are exhausted, automatic decisions retain at least the session effort for the rest of the conversation. The instance can save its own checkpoint for a later resume. A known superseding owner prevents further writes. Checkpoint files accumulate because another process may still be using its own file; resume reads all files for that conversation.

The router still sees bounded Read/Grep evidence, a repository summary, and recent task memory. It does not classify all shell or MCP output. Some tasks therefore correctly retain their starting effort with insufficient context. Broader evidence collection and weaker context thresholds were not supported by the earlier evaluations.

Claude Code 2.1.283 with Opus 5.5 still reproduces cache misses after effort changes in text-only acknowledgment conversations. Reasoning controls and the observed long-running user session retained the cache across changes. The router cannot establish the server's cause or independently control thread continuation. No validated production cache workaround was found.

Historical labels measure agreement with earlier model judgments. They do not measure completed task quality. Repeated paired runs reduce timing confounds, but local-decide confidence still varies. Historical transcripts do not contain every submission origin, prior classifier relation decision, or inherited task level; replay marks those gaps.

Three host assumptions remain outside the reproduced fixes. Turn completion still waits for the host state read to answer; only the decision wait is bounded. Ordinary batches whose transcript cannot be read still use queued text as a conservative fallback; strict delivery proof applies to prompts merged after the first decision. A second reload after the host refused the first transfer can read the older held memory before this instance's checkpoint. The reviewer identified that last path by inspection; it was not reproduced in native Claude. These limits remain explicit rather than counted as verified recovery.

Exact delivery framing is verified on Claude Code 2.1.283. Unknown wrappers do not count as proof that a pending prompt was delivered. Counterfactual replay of Codex logs does not mean this Claude plugin runs inside Codex.

## Test-driver correction

An early lifecycle driver failed to exit a Claude question dialog. Later launch text was consumed by that same session, and Claude invoked its Fable advisor. That run is discarded. Its transcript contains read-only shell commands, with no file-writing command. The effort-router dispatch hashes remained unchanged, and the dev-config worktree it inspected was clean. The runbook had not changed since September 27.

The final lifecycle driver restricts available tools and verifies an idle shell before launch and after exit. It uses self-contained prompts and rejects incomplete scenarios. The final launcher also sets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` for that process. Claude's normal tool whitelist does not disable the server advisor. The independent review used no advisor or subagent, as confirmed in its transcript.

## Final artifacts

All paths below are relative to the private evidence directory named in the next section.

| Evidence | Path |
|---|---|
| Frozen final implementation and SHA-256 receipt | `final-snapshot4/`, `final-snapshot4.json` |
| 270 plugin tests and TypeScript | `checks/final4-plugin-tests.log`, `checks/final4-tsc.log` |
| Strict validation and 22 replay checks | `checks/final4-validate.log`, `checks/final3-replay-check.log` |
| Complete Claude E2E result before the last correction | `live/effort-router-e2e-1790598557885/results.json` |
| Four focused Claude E2E checks after the correction | `checks/final4-e2e.log` |
| Before/after inheritance regressions | `checks/final4-before.log`, `checks/final4-plugin-tests.log` |
| Native queue verification | `queue/runs/verify-final-snapshot3.json` |
| Native lifecycle verification | `lifecycle/verify/final-snapshot3-20260928-143012/summary.json` |
| Independent review rounds | `review-result.md`, `review-fixes-result.md`, `review-final-result.md` |
| Paired classifier results and final input comparison | `final-eval/summary.json`, `final4-eval/prepare.json` |

## Evidence

Private traces, frozen lane patches, checks, and raw classifier inputs remain under `/Users/macstudio/.local/state/effort-router/2026-09-28-implementation`. Prior experiments are documented in [the uncertainty report](2026-09-28-uncertainty-verification.md).
