# A context hold no longer sets the floor for follow-ups

September 29, 2026, on Mac Studio, after v0.4.0. The [JSON receipt](2026-09-29-hold-continuation.json) records the replay counts.

## Problem

When the classifier cannot justify a lower effort, the router keeps the session effort. This is the context hold that the spinner reports as `router: needs context`. Through v0.4.0 the router then stored that kept effort as the task's level. A continuation of the task could not go below it, even when the continuation had enough context and a lower assessment of its own. Such follow-ups ran as `continue task` without the label.

A live session showed the pattern. The router held "Do we have the agentum repo on this computer" at xhigh, although the classifier assessed low (0.97). Its two follow-ups had sufficient context and assessed medium, yet both ran at xhigh. The label appeared on 4 model requests; the hold covered 9.

This conflicts with the rule that a sufficient-context decision sets the task's minimum. A hold is kept effort, not an assessment.

## Change

`routeOf` now also returns `unheld`, the level without the hold. The turn records the highest assessment it received, including messages typed during the turn and earlier prompts of a batch. It also records whether its level is effort a hold kept. At completion, a held turn passes on that assessment, together with the turn's own raises (mid-turn messages, batches, tool failures) and any earlier sufficient-context decision in the turn. These paths keep the previous behavior:

- A turn without a typed prompt still inherits the kept effort.
- Evidence that no answer assessed (spent discovery budget, a hook-budget deferral) passes on the effort kept for it.
- A message typed during the turn that got no answer passes on the kept effort.
- An assessment still in flight when the turn ends passes on the kept effort.
- A decision made on memory that can be stale passes on the effort it kept.
- A continuation that lacks context holds again and shows the label.

## Verification

All 278 plugin tests pass on Claude Code 2.1.285. TypeScript passes against the committed 2.1.283 declarations, and so do both plugin validations and the 22 replay checks. Eight new tests cover the reported pattern, a tool-failure raise, a hold kept for active work, a message typed during a held turn with and without an answer, a batch under a hold, and two controls. On v0.4.0, H1, H3 and H4 fail on the level; H2 fails only on the reason, which v0.4.0 reports as `continue task`.

The new E2E scenario `context-hold-continuation` runs two turns in one real Claude session against the stand-in classifier. It passes with the change and fails without it: the follow-up ran at xhigh and its previous task carried xhigh. `context-refresh` also passes.

An independent Codex review (`codex exec`, read-only) found two defects in the first version of the change. A message typed during a held turn, and an earlier prompt of a held batch, could raise nothing above the held level, so neither reached the level the task passed on. Both now count toward it; H6, H7 and the batch test fail without the correction. The review also found five defects in the replay script: discovery dropped an established continuation, applied raises only with sufficient context, ran on Glob-only evidence, counted a partial ensemble failure as a failed decision, and reset both arms after a failure. All five are corrected, and the numbers below come from the corrected script. The corrections can only keep effort higher, so no second review ran.

## Paired replay

`bun eval/hold-chain.ts` replays each recent interactive Claude session in order with the live classifier (`jev-latest` through the SVPG gateway) at an xhigh baseline. `before` passes on the kept effort; `after` passes on the assessment. Both arms share answers for identical request bodies.

| Measure | Result |
|---|---|
| Sessions, typed tasks | 163, 498 (no classifier failures) |
| Held tasks | 44 |
| Tasks whose level changed | 10: 9 lower, 1 higher |
| Historical model requests in those tasks | 267 of 5,714 |
| Changed tasks against the judge's labels, before | 0 below, 1 exact, 9 above |
| Changed tasks against the judge's labels, after | 0 below, 3 exact, 7 above |

Six changes were continuations of a held task, or of a follow-up that had inherited a hold. They include the live agentum follow-ups, which went from xhigh to medium; the judge labeled both low. The other four were new tasks. There, the only difference between the arms was the previous task's level in the classifier request, and the classifier answered differently. One of them, a literal reply, rose from low to medium.

Two earlier runs of the replay, before its corrections, changed 2 and 6 tasks. The classifier's answers to identical inputs vary between time windows.

## Limits

The judge (`local-smart`) is an independent model estimate, not measured task success. Ten changed tasks cannot establish a rate of under-thinking. They show only that the observed changes did not fall below the judge's labels.

Replay holds more often than the live router: 44 of 498 tasks, against 2 of 68 turns in the v0.4.0 decision logs. Replay has no repository summary and uses the deterministic continuation rule for memory. No replayed task read code before its first action, so replay never released a hold through discovery. Mid-turn messages, batches and tool-failure raises are not replayed; hook tests cover them.

The change does not address the first held turn. The context check still rejects many environment lookups and status questions that the effort question rates as simple. The earlier evaluations did not support loosening that check.
