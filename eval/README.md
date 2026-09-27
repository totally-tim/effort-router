# Context routing evaluation

Read [the live Claude results](results/2026-09-27-claude-e2e.md) for final-product e2e verification and the fixes it required. The [earlier context results](results/2026-09-27-context-routing.md) record the initial historical replay.

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
