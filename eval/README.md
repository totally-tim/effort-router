# Context routing evaluation

Read [the September 28 implementation results](results/2026-09-28-implementation.md) for context continuity, outage recovery, lifecycle verification, and the paired historical comparison. [The earlier live Claude results](results/2026-09-27-claude-e2e.md) record the first end-to-end verification. The [earlier context results](results/2026-09-27-context-routing.md) record the initial historical replay.

Run these commands with an installed Bun. They need no Claude generation and install no dependencies.

Run `bun eval/replay-check.ts` for local transcript extraction checks. The plugin's hook and policy tests run with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`.

The classifier is `local-decide`; an optional independent judge is `local-smart`. Both default to the SVPG gateway. Set `--gateway`, `--model`, `--judge`, `--key-file` and `--key-name` to override them. Keys are read from the specified file and never printed. The default key file is `~/.config/dev-config/secrets/providers.json`, under `SVPG_GATEWAY_KEY`.

```sh
bun eval/replay.ts pairs
bun eval/replay.ts sample --n 60 --seed context-routing-v1
bun eval/replay.ts prepare-labels
bun eval/replay.ts label
bun eval/replay.ts score --baseline high
bun eval/replay.ts report
bun eval/replay.ts cache
```

`sample` selects at most one task per session, balances the two log sources where enough sessions exist, and excludes sessions in the original evaluation. It records a manifest and a hash. It excludes active files modified within ten minutes, subagent logs, and files over 32 MiB. It examines up to 200 recent files per source. Keep the sample fixed before looking at scores.

Raw prompts, evidence, labels and predictions stay under `~/.local/state/effort-router/context-eval`. Use `--data PATH` for a separate run. Successful inspection excerpts are bounded and common credentials are redacted. Tool calls that reference credential paths are omitted from the judge's evidence. Inspect `judge-requests.jsonl` before sending unfamiliar logs to another service. The selected endpoint receives their contents.

`label` asks a separate model to estimate required effort from the historical task and observed work. It never includes router predictions or the recorded effort setting. The judge can mark a record unscorable. These labels are independent estimates, not proof of correctness.

`score` compares the old and current classifiers at threshold 0.95, with the same three context variants and duplicate-request handling. The current arm also applies the context guard. Initial routing sees only information from before the task. The separate discovery arm adds the available inspection excerpts. It is a comparison of those evidence snapshots, not a replay of every intermediate hook event. Hook tests verify those transitions.

Codex logs contain useful task and tool context for the independent judge. The live plugin currently accepts Claude Read, Grep and Glob results, so Codex shell-tool outputs do not become routing evidence. This limitation appears as missing context rather than fabricated observations.

For a regression comparison with existing labels:

```sh
bun eval/replay.ts import-labels --data /tmp/effort-regression
bun eval/replay.ts score --data /tmp/effort-regression
bun eval/replay.ts report --data /tmp/effort-regression
```

The importer restores historical context for the original labeled prompts where transcripts remain available. It uses the median of the existing model labels, with ties going higher. Those labelers saw limited context. This comparison measures regression against that earlier benchmark, not accuracy against complete task knowledge.

Reports include below-reference, equal and above-reference effort, abstentions, request failures, classification latency and classifier token usage. Historical token counts and tool failures are retained separately from routing predictions. Do not count historical failures as retries caused by a simulated effort choice. Monetary savings and first-attempt success require executing comparable tasks at different effort levels on the target model.

The report also applies an xhigh baseline to the same classifier answers. Baseline effort is a local policy input, so this comparison needs no new inference. An xhigh session retains xhigh when context is insufficient; a high session can retain high. Use the row that matches the intended session setting. The snapshot comparison does not reconstruct a previous turn's routed effort, so inherited effort floors are checked by the hook and paired-case tests.

`cache` compares adjacent requests at the same model in the historical Claude logs. It reports cache reads after effort changes and the fraction of the preceding input prefix reused. Elapsed time and other prompt changes are uncontrolled, so this is evidence about those observed paths, not a general cache guarantee.

## How replay rebuilds conversation memory

Replay builds each task's classifier input with the live router's own functions. `hooks/memory.ts` holds the previous exchanges, the latest background reply, and the previous task. `hooks/batch.ts` decides what a turn's request is when several prompts enter it. The transcript supplies these facts:

- A background completion's final reply becomes the next task's `previousAnswer`. The original task stays the previous request and the previous task.
- An answer is the final visible text of the turn: the text of its last assistant message. Text written before a tool call is judge evidence only.
- Typed rows that the transcript shows delivered together, with the same timestamp and no answer between them, form one task. A prompt that reached no model before the next one entered is neither a task nor memory. The live router remembers only turns that sent a model request.
- A prompt absorbed by a running turn (a `queued_command` attachment) joins that task's memory, not its classified request.
- `/clear` starts empty memory. A `relocated` row moves the session root, and today's Git layout decides whether the project changed. A shell `cd` never changes it.
- The previous task's observations cover the whole turn, including reads after an edit. The discovery arm still stops at the first action.
- Codex marks each turn: `task_started` opens it, and `task_complete` or `turn_aborted` closes it. Prompts in one open turn form one task, so a skill command stays with its `<skill>` expansion. A task's timestamp is its last prompt's. Codex's `<recommended_plugins>` and `<turn_aborted>` user messages are host text and never a request. A `<subagent_notification>` is a background completion. An aborted turn that reached no model leaves no task and no memory. Replay records an aborted turn that answered as interrupted.

Each sample has a `provenance` record of what replay cannot know. `unknown` lists the previous task's level. It also lists whether the previous turn continued an earlier task, when the deterministic continuation rule does not decide that. The live router took both from classifier answers. `project: 'unverified'` marks a root move to a directory that no longer exists. Replay keeps memory across such a move. `batch`, `delivered` and `cleared` record the delivery facts above. `unplaced` counts Codex prompts that reached no model in a log without turn boundaries. Replay never joins such prompts to the next one and leaves them out.

The transcript records no reliable marker for an in-process `/resume` or a new-process `--resume`, so replay keeps the preceding task memory. The live router restores bounded memory from checkpoints when the saved histories agree. Native lifecycle tests check that behavior, including ambiguous branches; historical replay cannot reproduce it. Replay also has no historical repository description, and its discovery arm omits the continuation that the live decision established.

`routingVersion` hashes every file under `hooks/`, so a change to `register.ts` or a new module changes every score fingerprint. `extract` admits interactive (`cli`) rows by default. Pass `{ entrypoints: ['sdk-cli'] }` for headless transcripts.

## Paired comparison of two trees

`compare.ts` compares the classifier inputs of two whole trees on the frozen labeled samples. Each arm uses its own extraction, request builder and routing policy. The tool only reads the frozen samples and labels.

```sh
bun eval/compare.ts prepare --before /path/to/baseline --out ~/.local/state/effort-router/compare-run
bun eval/compare.ts score --out ~/.local/state/effort-router/compare-run --reps 3
bun eval/compare.ts report --out ~/.local/state/effort-router/compare-run
```

`prepare` extracts each sample with both trees and hashes their request bodies. It sends nothing. Samples with identical bodies need no calls, since their difference is zero. `score` calls the classifier only for changed samples and interleaves both arms in one window, because identical bodies get different answers in different time windows. `--after` defaults to this tree. `--datasets 47=DIR,67=DIR` overrides the two frozen sets. After an integration, run `prepare --since <earlier out>`. Then `score` calls only samples whose bodies changed since that run. `score` refuses to run if either tree changed after `prepare`.

`report` gives the paired change in the sufficient-context probability with a bootstrap interval, levels at high and xhigh baselines, and counts below, equal to and above the frozen labels. The labels are earlier model judgments. Agreement with them is not a task-success result. Inputs, bodies and answers stay in `--out` with mode 600.

## Levels a context hold passes on

`hold-chain.ts` replays each recent interactive Claude session in order, so one task's routed level reaches the next task's previous-task level and continuation floor. `compare.ts` and `replay.ts score` cannot measure that, because they score single tasks. The `before` arm passes on the effort a context hold kept; the `after` arm passes on the classifier's assessment. The [September 29 results](results/2026-09-29-hold-continuation.md) describe the arms and their limits.

```sh
bun eval/hold-chain.ts run --sessions 200 --out ~/.local/state/effort-router/hold-chain
bun eval/hold-chain.ts label --out ~/.local/state/effort-router/hold-chain
bun eval/hold-chain.ts report --out ~/.local/state/effort-router/hold-chain
```

`label` asks the independent judge of `replay.ts label` about the tasks whose level differs between the arms. Inputs, answers and labels stay under `--out` with mode 600.
