# Context routing results, September 27, 2026

This snapshot precedes the live Claude verification and its fixes. See [the live results](2026-09-27-claude-e2e.md) for the current policy.

The context policy distinguishes the toy HTML explanation from the kernel explanation in the paired cases. It also reduces decisions below independent effort labels in historical replay. Missing context still blocks many downgrades, and these results do not measure task success or savings.

## Method

The classifier was `local-decide`. The SVPG gateway identified its build as `djev-spark-ec4ff3df-nvfp4`. The new policy uses the live request builder and routing function, a 0.95 effort threshold, and the three context variants used by the plugin. The comparison freezes the v0.2.0 request format and its handling of rounded probabilities.

The new sample contains 47 tasks from separate sessions: 17 Claude and 30 Codex. Sampling used seed `context-routing-v1`, examined up to 200 recent files per source, and excluded sessions from the original evaluation. The requested sample was 60; the eligible Claude sessions limited it to 47. The sample was frozen before scoring.

With the user's approval, `local-smart` independently labeled the sanitized historical records. It saw task context and observed work, without router predictions or recorded effort settings. It marked all 47 records scorable. The gateway returned the `local-smart` alias, without an immutable model build identifier. The labels were 18 low, 3 medium, 20 high, and 6 xhigh.

The separate regression set restores 67 of the original 86 labeled records. It uses the median of four existing label sets, with ties going higher. Those earlier labelers had limited context, so this is a regression reference rather than contextual ground truth.

Raw records remain outside the repository. [The aggregate JSON](2026-09-27-context-routing.json) records the results and fingerprints without task text. The routing source fingerprint is `27adf3496b9d3b30`.

## Historical tasks with new independent labels

Each row covers the same 47 tasks. "Below" and "above" compare the selected effort with the independent label. They do not establish that the task would fail or that extra effort would be wasted.

| Policy | Below label | Equal | Above label | Selected below xhigh |
|---|---:|---:|---:|---:|
| Fixed high | 6 | 20 | 21 | 47 |
| Fixed xhigh | 0 | 6 | 41 | 0 |
| Old router | 2 | 10 | 35 | 23 |
| New policy, high baseline | 1 | 19 | 27 | 25 |
| New policy, xhigh baseline | 0 | 16 | 31 | 11 |

The new policy blocked downgrades for insufficient context on 33 of 47 tasks. The remaining below-label case at the high baseline was a security and concurrency review. The router reported missing evidence and retained high; the independent judge chose xhigh. Using an xhigh baseline retained xhigh on that case.

On the 17 Claude tasks, the old and new policies both had zero below-label decisions; exact agreement rose from 7 to 8. On the 30 Codex tasks, below-label decisions fell from 2 to 1 at the high baseline, and exact agreement rose from 3 to 11. The Codex sample supplies varied real prompts, but the plugin itself still runs in Claude Code.

Median classifier latency increased from 286 to 311 ms; p95 increased from 364 to 409 ms. Total classifier input tokens increased from 36,555 to 69,678, about 1.91 times as many. These are classifier costs and latencies, excluding the coding model and local repository reads. All 99 classification snapshots completed without request failures.

Five Claude tasks had usable discovery excerpts. After inspection, all five still reported insufficient context; two matched the labels and three selected higher effort. This sample does not demonstrate useful discovery downgrades. The hook tests cover the transition that permits one before work begins.

## Regression against existing labels

| Policy | Below label | Equal | Above label | Selected below xhigh |
|---|---:|---:|---:|---:|
| Old router | 8 | 33 | 26 | 31 |
| New policy, high baseline | 1 | 37 | 29 | 24 |
| New policy, xhigh baseline | 1 | 31 | 35 | 12 |

The new policy reported insufficient context on 48 of 67 records. Median classifier latency was 415 ms for the old router and 423 ms for the new policy. Input tokens increased from 100,342 to 200,609. The 140 classification snapshots had no request failures.

## Paired cases and verification

All 12 synthetic cases selected effort within the expected range. Eleven also met the context-sufficiency expectation.

- The same explanation request selected medium for a toy HTML file and xhigh for kernel scheduler code.
- A specified typo selected low in both repositories.
- An unresolved target prevented a downgrade.
- A hard continuation retained xhigh. It reported insufficient context despite the fixture expecting sufficient context, so this case failed that part of the check.
- A new literal reply after hard work selected low.
- A recognized instruction aimed at the router inside a source comment prevented a downgrade.

Verification passed: 66 plugin tests, 3 transcript extraction checks, the production TypeScript check, the evaluator build, plugin validation, and `git diff --check`. The hook tests exercise initial routing, bounded discovery, continuation, manual effort, subagent isolation, and late results after a session reset.

The required independent source review was attempted with `claude -p`, but the CLI returned HTTP 429 because the weekly quota was exhausted. There is no completed independent code review. Fresh Claude generation and the live generation e2e suite remain unverified for the same reason.

## Cache observations and limits

Across 266 historical Claude sessions, six adjacent requests changed effort while keeping the same model. Four Opus 5.5 transitions all reused at least 95 percent of the preceding input prefix. One of two Fable 5.1 transitions met that threshold; both read some cached input. Other prompt changes and cache lifetime were uncontrolled. These observations do not guarantee cache reuse on another model or request path.

Historical replay uses only evidence present in the logs. It cannot restore the original repository summary, and it does not reconstruct the previous turn's routed effort. Codex shell output is available to the independent judge but is excluded from routing evidence because the live plugin accepts Read, Grep, and Glob. Discovery is evaluated as a later evidence snapshot, rather than every intermediate hook event.

Independent model labels estimate required effort. They are not counterfactual executions. The sample is small and comes from one developer's sessions. Classifier outputs varied between runs; the figures above use the final recorded fingerprints. No retry, success-rate, or dollar-savings claim follows from this evaluation.
