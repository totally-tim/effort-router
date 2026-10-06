# A background completion's context hold keeps high

October 6, 2026. The analysis used the decision logs of both hosts that run v0.4.1, the laptop and the Mac Studio. The [JSON receipt](2026-10-06-notification-hold.json) records the counts. No prompt text leaves the hosts. The receipt holds aggregates only.

## Problem

Both hosts run v0.4.1 in enforce mode with a session effort of xhigh, the 0.95 threshold, and the SVPG gateway's `local-decide` classifier. The audit covers sessions that started after each host updated to v0.4.1, from September 30 to October 5. That is 377 laptop turns and 811 Studio turns. The router sent xhigh on 96% of the laptop turns and 80% of the Studio turns.

The audit puts each turn into one group by the rule that set its level, and splits the turns by source. *Background* turns are `<task-notification>` completions. *Automated* turns are Orca orchestration messages, subagent hand-backs and account-switch handoffs. Both kinds reach the router as text.

| Group | Laptop | Studio |
|---|---|---|
| Lowered below the session effort | 7 | 156 |
| xhigh only because of the threshold, with a lower most likely level | 181 | 249 |
| Context hold at the session effort | 32 (27 background) | 174 (85 background, 63 automated) |
| Continuation floor | 87 | 135 |
| xhigh as the most likely level | 51 | 51 |
| Other: discovery budget, fallback, mid-turn, medium sessions | 19 | 46 |

A separate model labeled 203 stratified turns blind with [`labeler-prompt.md`](../labeler-prompt.md). It did not see the router's levels. On the sample, the router sent more effort than the label on 92% of laptop turns and 77% of Studio turns, weighted to each host's mix. It sent less on 0.8% and 1.7%, all by one level. All 30 sampled holds were above their labels. Releasing them would have put none below. Of those 30, 28 were background or automated turns, mostly labeled low.

The 0.95 threshold is not the main cause. Context was insufficient on all 181 laptop threshold turns and on 228 of the 249 Studio ones. On those turns the classifier also spreads probability toward xhigh. With a lower threshold, the hold sends the same turns back to the session effort. A global threshold of 0.90 doubled Studio under-routes in replay, from 7 to 16, and left the laptop at 98% xhigh.

A background completion passes no level on, because `afterNotification` updates only the latest answer. Holding it at xhigh therefore protects no later task. The September 29 report did not address a first held turn. Its limits note that the context check rejects many status questions that the effort question rates as simple.

## Change

A context hold on a turn that a host-attested background completion started now keeps at most `high`. It never keeps less than the classifier's assessment. A session already below high keeps its own effort. The hold still shows as `router: needs context`, and discovery can still release it to a lower level.

The cap applies only when all of the following are true:

- The turn's submission origin is `task-notification`.
- Every prompt that entered the turn is a notification.
- Task memory is current: no memory takeover is pending, and none has missed without a later merge.
- The decision got a classifier answer.
- The effort was not set by hand.

Text that only looks like a notification keeps the session effort. So do a message typed during the turn, a turn on task memory that can be stale, a failed decision and a failed discovery. The cap also applies when a spent discovery budget or a hook-budget deferral retains the held effort.

The decision log gains these fields for the next evaluations:

- the submission `origin`;
- the first decision's level (`decided`) and its level without a hold (`unheld`);
- the raw context and relation answers before the 0.8 cutoffs (`context_answer`, `relation_answer`);
- `candidates`, the levels two later policies would pick from the same answer:
  - `accept_uncertain` treats a context answer of `sufficient` below 0.8 as sufficient;
  - `xhigh_min_mass` also lets an xhigh share below 15% count as high.

Candidates are logged and never sent. Messages typed mid-turn log their raw answers as well.

## Replay

The replay took each host's sessions in order and applied the current rule and the new rule to the logged classifier answers. It scored both against the blind labels. Logs from v0.4.1 have no `origin`, so the replay used `task_notification` instead. The current rule reproduces the logged level on 362 of 363 laptop turns and 749 of 782 Studio turns in xhigh sessions.

| | Laptop current | Laptop v0.4.2 | Studio current | Studio v0.4.2 |
|---|---|---|---|---|
| xhigh share of turns | 98% | 90% | 79% | 68% |
| Below / equal / above label, weighted | 0.8 / 7.5 / 91.8% | 0.8 / 8.9 / 90.3% | 1.7 / 20.8 / 77.5% | 1.7 / 22.5 / 75.8% |
| Turns whose level changes | | 27 | | 89 |
| Labeled turns that change, below label | | 14, 0 | | 9, 0 |

No changed turn fell below its label. With 23 changed labeled turns, that only bounds the rate of under-routing below about 12%. Most notification turns with missing context still reach xhigh through the threshold, so this change removes only the visible holds.

## Verification

All 302 plugin tests pass, including 24 new ones:

- A held notification sends high and keeps reporting the hold.
- Sufficient context, a medium session, an xhigh assessment, a typed lookalike, an unstamped envelope, manual `max` and a mid-turn message behave as before.
- Discovery still releases the hold.
- A still-insufficient discovery and a spent budget keep high, while a failed discovery and a failed first decision keep the session effort.
- A hook-budget deferral keeps high.
- A completion on task memory that can be stale keeps the session effort, with or without missing context.
- A typed prompt queued with a completion keeps the session effort, and completions that enter together hold at high.
- Each candidate, the raw answers and the new log fields are computed and logged.

Without the cap, 8 of those tests fail. TypeScript passes against the committed 2.1.283 declarations, both plugin validations pass, and `bun eval/replay-check.ts` passes all 22 checks.

`bun e2e/e2e.ts stub-background-notification` runs only when named. Claude Code 2.1.291 started a turn for a real background `sleep`. The router logged it with origin `task-notification`, held it for missing context, and sent high. `context-hold-continuation` and `context-refresh` pass unchanged.

## Limits

- One model labeled each turn and saw its final answer. Labels are estimates, not success measurements.
- The judge labeled about 15 Studio subagent hand-back rows from the wrong transcript prompt, because the join of log records to transcripts matched them incorrectly.
- The replay re-ran no task at the new level, so cost savings remain unmeasured.
- Orca orchestration messages arrive as typed text (`composer`). They are not covered, because matching text would let any prompt claim the exemption.
- A completion that starts while a memory takeover is pending keeps the session effort for the whole turn, even when the takeover completes during the decision.
- A turn that a reload adopts after its takeover already completed keeps its pending mark, so the cap never applies to it. The adoption path also never joins that turn's late prompts. That gap predates v0.4.2.
- The later candidates need the new log fields and blind labels on their disagreements before any of them is enforced.
