# Outage recovery and the needs-context label

Checked September 27, 2026, with Claude Code 2.1.283 and Opus 5.5 on Mac Studio.
The tested runtime files matched the installed effort-router v0.3.0 files.
Only tests and documentation changed during this investigation.

## Live session observations

The Railway migration session `040691ea-e039-4ff0-bae1-c4f17dd9d16d`
displayed `at xhigh effort (router: needs context)` while continuing its migration.
Its recent tool history was dominated by Bash calls. The recorded Read in that
part of the conversation was a runbook. Shell and MCP output do not become
router evidence.

The label requires a successful classification followed by the context guard.
It is separate from `router: timeout` and `router: classifier paused`. The guard
can retain the starting effort even when Claude has enough information to work,
because the router receives only bounded evidence and recent exchanges.

The HerdApp session `7ab5449d-cbb8-494a-8b2e-09750623aa89` also displayed the
label. Its last completed turn recorded successful classifier calls in 274,
175, and 221 ms. The two discovery checks reported `missing_evidence`.
Later source reads exhausted the discovery allowance.

The current Railway turn had not completed, so its exact missing-context fields
were not yet in the decision log. A read-only `/effort-router status` command was
submitted, but its output was not captured in the working pane. The active user
sessions were not restarted or given a diagnostic task.

## Recovery test

The test ran six turns in one real Claude process and session. A local proxy
delayed the first three classifier responses beyond the normal five-second
deadline. After the pause, it forwarded requests to the live local-decide
endpoint using the existing gateway credential.

| Turns | Classifier state | Actual request effort |
|---|---|---|
| 1 through 3 | Timeout at 5,003 ms each | xhigh |
| 4 | Circuit breaker paused requests | xhigh |
| 5, after a 301-second pause | Live success in 252 ms | low |
| 6 | Live success in 140 ms | low |

The transcript matched every recorded effort. The paused turn made no classifier
request. No process restart, session reset, or configuration change was needed.
The test lasted 328 seconds. The [JSON receipt](2026-09-27-outage-recovery.json)
contains the session ID, timings, efforts, cache measurements, and original result.

The original end-to-end test failed one cache assertion. After the idle pause,
request 5 read 3,102 of the preceding 8,265 input tokens from cache. Recovery
assertions passed. The test now checks cache reuse between the two adjacent
recovered turns, without requiring retention across the five-minute pause.
That assertion passed against the saved transcript: request 6 read 8,300 of the
preceding 8,302 input tokens. The complete end-to-end run was not repeated after
this assertion change. The cache-loss cause was not independently isolated.
The five-minute pause alone does not establish cache expiry or router-caused
invalidation. The test did not establish its cache TTL.

All 82 plugin tests passed, including two added regression tests for recovery
without a reset and a healthy needs-context decision followed by a new literal
task. TypeScript, the end-to-end runner build, and whitespace checks passed.

## Production cache observation

After this investigation, the user reported the following `/context` dashboard
values from a long-running Claude agent. The session ID was not supplied.

| Measurement | Dashboard value |
|---|---|
| Main requests | 394 |
| Input tokens read from cache | 99% |
| Cache misses | 3 |
| Most recent miss | 48 minutes, 39 seconds before the observation |
| Tokens cached again at that miss | 914.1k |
| Reported cache lifetime | 1 hour |
| Current cache state | Warm; last activity 2 minutes, 29 seconds earlier |

These values show strong cache reuse in that session and no recent misses.
The dashboard attributed the last miss to likely idleness beyond the one-hour
TTL. That is a diagnostic hypothesis, not an independently verified cause.
This observation provides no evidence of repeated router-caused cache misses.
It does not identify the cause of the separate six-turn test's partial miss.
The dashboard also does not show which requests changed effort.

## Recovery boundary

After three failures, the router waits five minutes before allowing another
classification. A successful classification clears the failure count. Elapsed
time alone does not create a request; a plugin test verifies that boundary.

A new typed turn can recover. Messages during a turn and eligible discovery can
also ask again, but messages can only raise effort and discovery has two checks
per turn. A long-running task can therefore keep its earlier effort and label
after the service returns. Needs-context decisions can also persist when the
task relies on shell or MCP output. Those are limits of the current evidence
and retry policy.
