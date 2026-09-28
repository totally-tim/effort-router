# effort-router

effort-router is a Claude Code mod that picks the reasoning effort for each turn of the main conversation. It asks a System One classifier how much reasoning a typed prompt needs, sends that level through the `turn.step` function hook, and shows the level where Claude Code already reports progress:

```
✽ Ionizing… at low effort
✻ Sautéed at low effort for 3s · done 11:06 AM
```

The classifier is [Jev](https://learnjev.com/reference) on TypeSafe's hosted API by default. Any service that speaks the same System One contract works too: set its base URL, model and key.

In shadow mode the router logs its pick and sends the session's effort unchanged. In enforce mode it sends the pick.

## Requirements

- Claude Code 2.1.283 or later, with function hooks turned on: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The Mods API is early access and can change between releases.
- An API key for hosted Jev, or for a compatible service.
- A model that takes an effort setting. An effort change can cost prompt-cache reuse, depending on how Claude Code sends it and on the conversation. See [Prompt cache and effort changes](#prompt-cache-and-effort-changes) before treating effort changes as free.

Set the flag in the `env` block of `~/.claude/settings.json`, so that every session gets it: shells that were already open, the desktop app and the IDE extensions included. A shell `export` reaches only the shells started after it.

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

## Install

```sh
claude plugin marketplace add totally-tim/effort-router
claude plugin install effort-router@effort-router
```

The router starts in shadow mode. Watch a few turns, then switch with `/effort-router enforce` for one session, or set `mode` to `enforce` in `/config` for all of them.

To run a working copy for one session instead:

```sh
claude --plugin-dir path/to/effort-router --settings '{"enabledPlugins":{"effort-router@effort-router":false}}'
```

A `--plugin-dir` copy reloads on every save. The `--settings` part disables the installed copy for that session, so the two copies don't both route.

## What you see

While a turn runs, the spinner says the level of the request in flight. The line that closes the turn says the level its last request went out at. A note in parentheses says why, when the router did not simply pick the level:

| Note | Meaning |
|---|---|
| none | The classifier's pick, or the previous turn's for a turn without a typed prompt |
| `you asked to think hard` | "ultrathink", "think hard", "think deeply" or "take your time" set a floor of xhigh |
| `raised by your message` | A message you typed during the turn needed more reasoning |
| `raised after failed tool calls` | Two or more tool calls failed in this turn |
| `set by hand` | You set the effort (`/effort`, `--effort`), so the router left it alone |
| `router: timeout`, `router: http 503`, `router: no API key` | The classifier gave no answer, so the turn kept the session's effort. `, retrying` means the classifier has answered another request since, and the turn will ask again on a later request |
| `router: needs context` | A classification succeeded, but the available task evidence did not justify lowering effort |
| `router: medium` | Shadow mode: what enforce mode would have sent |

In enforce mode the spinner says `choosing effort` while the router waits for the classifier. A problem with the setup, such as a missing key or a classifier that keeps failing, is said once per session as a dim line in the transcript.

Claude Code's own effort display (the header, `/effort`, the `CLAUDE_EFFORT` variable and the status line's `effort` field) keeps showing the session's level, not the level the router sent.

## Configuration

The router finds its classifier the way the TypeSafe SDKs do:

| Setting | Option | Environment variable | Default |
|---|---|---|---|
| Base URL | `baseUrl` | `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` |
| Model | `model` | `TYPESAFE_DEFAULT_MODEL` | `jev-latest` |
| API key | `keyFile` and `keyName` | `TYPESAFE_API_KEY` | none |

An option wins over the environment. The router posts to `<base URL>/v1/systemone` with `Authorization: Bearer <key>`. It uses the System One contract (`model`, `state`, `questions`) with four choice questions: effort, the reasoning needed to understand the work, whether context is sufficient, and whether the request continues the prior task. A service that omits the context or work answer cannot authorize a downgrade.

A key file is a JSON object that holds the key under `keyName`, or a file that holds only the key. For example, a self-hosted service whose key sits in a shared secrets file:

```json
{
  "pluginConfigs": {
    "effort-router@effort-router": {
      "options": {
        "mode": "enforce",
        "baseUrl": "https://decide.example.com",
        "model": "jev-latest",
        "keyFile": "~/.config/secrets/providers.json",
        "keyName": "DECIDE_KEY"
      }
    }
  }
}
```

The other options:

| Option | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off`, `shadow` or `enforce` |
| `floor`, `ceiling` | `low`, `xhigh` | The range the router may pick from. max stays manual |
| `threshold` | `0.95` | The cumulative probability the pick must reach |
| `ensemble` | on | Average three contexts, not just one |
| `headless` | off | Also route `claude -p` and SDK sessions |
| `logDir` | `~/.local/state/effort-router` | Where the decision logs and resume checkpoints go |
| `timeoutMs` | `5000` | How long enforce mode waits for the classifier |

Set options in `/config` under the plugin, or under `pluginConfigs` in settings.

## Where your prompts go

For each typed prompt, the router sends the classifier the prompt (up to 4,000 characters), the previous prompt and answer (up to 1,000 characters each), the two exchanges before those (up to 500 characters each), and counts of how the last user turn went. Long excerpts retain their beginning and end, including pending steps at the end of answers. With hosted Jev that is TypeSafe's service. Choose a self-hosted service if prompts must stay on your own hardware.

When a background task's completion notification started the latest turn, the reply to that notification becomes the previous answer. Up to 1,000 characters of it go out with your next prompt, and the router still keeps your own earlier task as the task. That reply can restate shell or MCP output that the router does not collect directly. The router filters it with the same credential patterns.


It also sends a repository summary of up to 1,600 characters, collected from README.md and package manifests in the working directory. The summary is cached until the directory or session changes. Task evidence includes up to four successful Read, Grep or Glob results, at most 1,600 characters each, and the previous task's request, answer, effort and evidence. Shell output is excluded. Credential paths and common token patterns are filtered; this is not a general secret detector.

The decision log stays on your machine. It records evidence paths and lengths, without copying tool-result text.

To go on after `/resume` or `claude --resume`, the router also saves each conversation's task memory in `logDir`, as `<session>.memory.<writer>.json`. A checkpoint holds at most three typed requests of 4,000 characters each and their answers of 1,000 characters each. It also keeps the previous task's request and answer at 1,500 and 1,200 characters, and the latest background reply at 1,000 characters. All text uses the classifier's redaction rules. It also holds the level an empty turn inherits, the project identity and the usual level. It holds no tool output.

## How it decides

1. The first request of a turn asks the classifier with up to three contexts in parallel and averages the answers:
   - the prompt with the previous prompt and an excerpt of the previous answer;
   - the same plus the two exchanges before those;
   - the same plus how the last turn went: failed tool calls, model requests, and whether you interrupted it.

   Every variant includes the same task evidence. Identical request bodies are sent once, so a session's first turn makes one call. Effort and work scores use all answered variants. Context sufficiency and task continuity use the variant with the most conversation history; previous-turn error counts cannot veto that context assessment.
2. For both effort and work complexity, the pick is the lowest level whose cumulative probability reaches the threshold. Work maps mechanical actions to low, bounded local behavior to medium, component dependencies to high, and difficult invariants to xhigh. The higher of the two picks wins. This is a routing heuristic, not a measured probability of task success. max stays manual.
3. "ultrathink", "think hard", "think deeply" and "take your time" set a floor of xhigh.
4. A turn with empty text gets the previous user turn's level. Only a level the router chose passes on. A typed turn without a classifier answer passes on the session effort it kept, or a higher earlier level. A turn with effort set by hand passes on no level of its own, and the router drops an earlier level below the usual one. Without an answer, "Continue" and the other continuation phrases keep the task they continue. Background completions get their own decision but do not replace the remembered user task, exchanges, metrics, or effort. The engine's submission origin identifies them; user-typed notification examples remain user tasks.
5. The router also classifies a message you type while a turn runs, whether you press Enter or queue it with `ctrl+x enter`. Claude Code delivers either one at the running turn's next tool result. The message can raise the rest of the turn, never lower it, and once delivered it becomes part of the turn's remembered task. The router does not classify messages nobody typed, such as background completions, while a turn runs.
6. From the second failed tool call in a turn, the rest of the turn runs one level higher. From the fourth, it runs two levels higher.
7. Effort you set by hand wins. A turn whose effort differs from the session's usual level runs at that level, and routing resumes once the effort is back at the usual level. max always counts as set by hand. The usual level is the one saved for the model under `modelSettings`, else the first turn's level.
8. When something else changes effort mid-turn, such as a skill with `effort:`, the router leaves that request alone.
9. The router never changes a subagent's requests.
10. Prompts queued behind a turn can start the next turn together, but Claude Code gives the router only the last one. The router reads the user messages after the conversation's last answer to see which queued prompts entered. It decides the turn on those prompts joined in order, and the verdict each earlier prompt got when it was typed can raise the turn. If the conversation cannot be read, or does not show the turn's own prompt, every prompt queued over the previous turn counts; this can only raise effort. A prompt already delivered into the previous turn does not count toward the next one. Background completions in the batch are left out of the task. Claude Code gives submissions no identifiers, so the router matches prompts by their exact text.

Missing context prevents a downgrade below the session's starting effort. An unresolved "how does this work?" needs evidence of its target; a repository name or description alone is insufficient. The selected conversation variant must assign at least 0.8 probability to sufficient context. If that variant fails, the router reports a classifier failure and retains effort; the other variants cannot authorize a downgrade. Recognized instructions aimed at the router inside tool evidence also prevent a downgrade.

The work question adds a separate estimate of the code relationships the task requires the agent to understand. A requested short answer does not by itself establish simple reasoning. A fully specified typo or a literal reply can still use low effort in a complex repository.

For explanations, reviews, and similar code analysis, inspected memory-ordering or compare-and-swap operations set a minimum of high, subject to the configured ceiling. This narrow safeguard covers recognized concurrency primitives; it is not a general complexity detector.

The router can ask for a discovery decision at most twice per turn. File listings remain hints; only Read content or matching Grep content can resolve a referenced target. Empty searches and file listings do not consume discovery checks. It may lower effort when missing context held the current level and later becomes sufficient, before any action beyond inspection. An uncertainty check or failure that leaves a confident pick unchanged cannot grant permission to lower it later. Once work has begun, discovery can only raise effort. Fresh source after the discovery budget is spent restores at least the starting effort. An established continuation keeps the preceding task's effort floor and findings through later discovery decisions. Independent tasks get a fresh decision.

In enforce mode an initial or discovery decision waits up to the classifier timeout, 5 seconds by default. Shadow mode does not delay model requests for these decisions. When the classifier doesn't answer in time or fails, the turn keeps the session's effort. After three failures in a row the router stops asking for 5 minutes.

The cooldown expires without restarting Claude. The next classification attempt can reach the service again; a successful response clears the failure count. There is no background health probe. A new typed turn, a message during a turn, or eligible discovery can trigger an attempt. A turn whose own decision got no answer also asks again on later model requests for as long as it runs. After each failed attempt it waits 1 minute, then 2, then 4, then at most 5 minutes. It sends one request at a time and none while the router is paused. When the classifier answers a message you type during the turn, the turn asks again on its next request. A retry can raise effort but never lowers it, and messages during a turn can only raise effort. `/effort-router status` reports the classifier's latest result and does not make a fresh request. A request that finishes after a newer request has returned the opposite result changes neither that report nor the pause. `/effort-router why` describes the last completed turn.



`router: needs context` means missing context prevented a lower effort choice. It can appear while the classifier is healthy. If the effort scores or task floor already require that level, the warning is omitted; the log still records missing context. A successful discovery check refreshes the context fields even when effort stays fixed. When work has already begun and the new recommendation is lower, the label says `kept for active work`.

The router sees bounded Read and Grep evidence, a repository summary, and recent user exchanges. It does not see the full Claude conversation or shell and MCP output. A task that uses those tools can retain its starting effort for the whole turn. A separate self-contained task receives a fresh decision. If neither the submission nor its saved origin is available, the router falls back to the notification envelope. Other generated messages can still enter task memory. When prompts were queued, the router reads the user messages after the last answer on your machine, only to match them to the prompts you submitted; the classifier then receives those prompts joined.

## Command

`/effort-router` also runs mid-turn.

| Argument | Effect |
|---|---|
| `status` (default) | Mode, range, threshold, classifier health, key status, any unanswered running-turn assessment, the last decision, observed cache outcomes, and the log path |
| `why` | The full record of the last turn |
| `shadow`, `enforce`, `off` | Switches the mode for this session |
| `wrong <level>` | Labels the last turn with the level it should have had |

## Decision log

Each plugin instance writes its own file for the session, `<logDir>/<session>.<writer>.jsonl`. A reload, `/resume` or `claude --resume` starts a new file and leaves the earlier ones unchanged, so no two instances or processes write the same file. To read a whole session, read every `<session>.*.jsonl` file in name order. Earlier versions wrote one `<session>.jsonl`; the router still reads it for the usual level and never writes it. Every line is one turn or one label.

A turn record holds:

- the classifier's averaged probabilities and the pick;
- the usual level, and whether the effort was set by hand;
- each request's effort, duration, and input, output, cache-read and cache-write token counts, with `cache` (`hit`, `miss` or `cold`) and `effortChanged` against the previous main-conversation request (see [Prompt cache and effort changes](#prompt-cache-and-effort-changes));
- any mid-turn raises, the prompts delivered into the turn while it ran (`delivered`), and how many queued prompts started it together (`batch`);
- the number of failed tool calls;
- the turn's token usage;
- the first 200 characters of the prompt, so turns can be labeled later.
- context sufficiency, whether missing context held effort (`context_held`), missing information, task continuation, background notification detection, and discovery decisions;
- the highest level a sufficient-context decision chose in the turn (`assessed_floor`), and on a discovery decision, that floor when it replaced a lower answer;
- on a request, whether the hook's time budget was too short to check new evidence or a due retry (`deferred`, with the remaining and needed milliseconds);
- the classifier's response time for each message typed during the turn.

Task memory follows the Git repository, including its linked worktrees and symbolic paths. A shell directory change refreshes the repository summary without clearing task memory. A different project starts fresh memory.

## Sessions, reloads and resume

- `/clear` and an in-process `/resume` end the conversation with `session.end` and go on under another session id. The router then forgets the old conversation's turns, memory and log. If the session id changes without `session.end`, the router notices at the next turn's first request.
- A hot reload of the plugin can split a turn between the old and the new instance. The old instance keeps the running turn and the task memory in session-held state (`$.state`), and the new one adopts them. The new instance keeps the turn's decision, effort, evidence and record. If the old instance's decision had not arrived, the new one asks the classifier again. The new instance takes each value over with compare-and-set, so later writes from the old instance fail.
- If a reload races a write from the previous instance, the new instance makes at most four transfer attempts on later hooks. Each decision waits at most one second for a pending memory read; shadow requests keep going. While memory is unresolved, automatic decisions keep at least the session effort. If the host refuses the transfer or attempts run out, that floor lasts for the conversation. The instance still saves its own checkpoints for a later resume unless another writer has taken ownership. This is separate from classifier outages, which retry as described above.
- A resumed conversation restores its task memory from its checkpoints only when they form one line, each save going on from the one before. If two processes went on from the same save, the router cannot tell which memory is current. It restores none, and turns keep at least the session's effort until a typed turn completes. The router also restores none when the newest save cannot be read or a save does not lead to the newest one. The next save names the newest saves as its parents, so a later resume finds one line again. `/effort-router status` says when memory was not restored.

## Prompt cache and effort changes

The router's only control is the effort of each request, which it passes to Claude Code through `turn.step`. Claude Code decides how to send it. On Claude Code 2.1.283 with Opus 5.5, that one value sets the request's top-level effort and a per-turn effort message, and it also decides whether the request continues the server-side conversation thread. The router cannot set these parts separately. The Mods API promises nothing about prompt-cache reuse across effort changes.

The September 28 measurements on one account show that the result depends on the conversation:

- When the answers contain thinking, effort changes kept the cache. All 60 follow-up requests of a reasoning experiment hit, including raises and lowerings on the default path. All 10 effort changes in the first 394 requests of a real long session also hit.
- In a text-only acknowledgment experiment, effort changes re-cached the conversation after the system prompt. Those requests read 3,116 of 8,245 and 8,305 prompt tokens from cache. The same prompts at a fixed effort kept the cache. Later verification also saw hits after some effort changes in this scenario: a text-only first answer is a test condition, not a reliable predictor of a miss.
- The same loss happened without the router: after 301 seconds idle at a fixed effort, the server no longer had the thread, and the next request read only 3,099 of 8,344 tokens from cache.

The server's cache placement is not observable, so the cause of the text-only case is not established. A Claude Code or server change can alter these results. A fix needs a host change: Claude Code would have to render the conversation the same way whether a request continues the thread or starts it again, or keep the thread across effort changes. Keeping the thread while changing effort was tested only with a local proxy, which is unsupported. In that test, thinking-token counts after a lowering matched low effort, but the counts after a raise did not show whether the higher effort applied.

The router therefore does not change its routing to avoid cache misses. Skipping a raise could cost answer quality. Skipping a lowering costs extra reasoning tokens, and the router cannot tell in advance whether a change would miss.

It records what happened instead. Each main-conversation request in the decision log carries `cache` and `effortChanged`, compared with the previous request of the same conversation and model. The rule is the one Claude Code's `/context` cache ledger uses: a request misses when it reads less than 95% of the smaller of the two prompts from cache and falls at least 2,000 tokens short. `/effort-router status` sums these outcomes:

```
cache since 10:02 UTC (usage estimate): misses at 2 of 3 requests after an effort change, 0 of 11 others; 10.4k tokens re-cached
```

A miss after an effort change shows a correlation, not a cause. Idle expiry and compaction also cause misses. The counts start with the first request the router sees. They restart when the plugin reloads or the conversation changes, including `/clear` and `/resume`. The router does not compare subagent requests, or a request with a different model than the one before it.

## Evaluation

The original threshold and ensemble came from an evaluation on 84 prompts from one developer's sessions. Four model labelers estimated effort from prompts and limited prior text. Their median, with ties going to the higher level, was the reference label. Their exact agreement ranged from 47 to 81 percent.

The original router selected effort below that reference label on 8 percent of prompts and selected below xhigh on 54 percent. Those figures measure label agreement. They do not establish actual task success, retries or savings, and they do not describe the current context policy.

`eval/replay.ts` evaluates the current policy with synthetic paired contexts and historical Claude and Codex tasks. It uses the live request builder, routing policy, and task-memory functions. Fingerprints include every module under `hooks/`. The old request format is frozen in the evaluator for comparison. Read [the evaluation guide](eval/README.md) for sampling, independent labels, replay and cache checks. No Claude generation is required for these checks.

The [September 28 implementation report](eval/results/2026-09-28-implementation.md) records the current fixes, native Claude checks, historical comparison, and remaining limits.

Hosted Jev has not been measured. Its probabilities may be calibrated differently, so run the eval on your own prompts, or watch shadow mode for a while, before you enforce.

`eval/effort-eval.ts` retains the original prompt sampling and probability benchmark. It does not evaluate the context guard or discovery policy. Its data stays in `~/.local/state/effort-router/eval`.

```sh
bun eval/effort-eval.ts sample --days 30 --n 150   # typed prompts from your interactive sessions
bun eval/effort-eval.ts autolabel                  # label them with three opencode models
bun eval/effort-eval.ts label                      # optional: your own labels, which then become the truth
bun eval/effort-eval.ts score                      # agreement, context variants, threshold sweep
bun eval/effort-eval.ts report --days 7            # effort mix and token use against the weeks before
```

`score` asks the classifier set by `--base-url`, `--model`, and `--key-file` with `--key-name`, else by the `TYPESAFE_*` variables. It keeps each classifier's answers apart, so a change of service, model or request wording starts a fresh score. `autolabel` runs `opencode run` with `eval/labeler-prompt.md`; `--models` picks the labelers.

## Tests

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude plugin validate .                            # the marketplace manifest
claude plugin validate .claude-plugin/plugin.json   # the plugin manifest and its hooks
claude plugin test .
bun eval/replay-check.ts                            # transcript extraction checks
bun e2e/e2e.ts [--model <id>] [--list] [scenario ...]   # real headless sessions
```

`claude plugin validate .` checks only the marketplace manifest in this repository. The explicit `.claude-plugin/plugin.json` path validates the plugin manifest and traces its hooks.

The engine's API declarations under `.claude-plugin/types/` are committed, so the typecheck runs against the API surface the mod was written for. Neither validate command writes them on Claude Code 2.1.283.

`e2e/e2e.ts` runs real headless Claude Code sessions, each with its own log folder, and checks each request's effort in the transcript against the decision log. Some scenarios ask a local stand-in that holds requests to hosted Jev's contract: it refuses a wrong key, an unknown model and any field the contract does not have. Those scenarios cover the options and the environment variables, a rejected and a missing key, shadow mode, a classifier that is down or hangs, a launch effort set by hand, the headless default, off mode and a subagent.

The `real-*` scenarios ask the classifier your `TYPESAFE_*` variables name. They cover simple and difficult work, explicit effort cues, toy and scheduler-code discovery, unresolved targets, untrusted source instructions, task continuity across turns, and user messages that resemble background notifications. `context-refresh` uses a controlled classifier to verify that discovery after an action updates the reason while effort stays fixed. `real-outage-recovery` simulates three timeouts, verifies a paused fourth turn, waits through the real five-minute cooldown, then forwards two decisions to the live classifier in the same Claude process. It has a seven-minute test deadline. The runner checks actual request effort, cache reads across changes, and step telemetry. It treats Claude errors, missing turns, permission denials, and a test deadline as failures; other scenarios have a five-minute deadline. Each session disables every installed copy of the mod, and the runner fails a scenario unless the debug log shows that only this folder's copy loaded. Real classifier scenarios are skipped without `TYPESAFE_API_KEY`, and the summary lists each skip. `--list` names the scenarios. Logs and a `results.json` summary stay in the printed temporary directory.

The summary reports routing and cache separately. Routing covers the router's own behavior, including its logged cache diagnostics. Cache covers prompt-cache reuse, which the host controls. A cache failure reads as `KNOWN` only when it matches the pattern observed on September 28, which is not a proven cause. Every condition must hold. The scenario is one of the two reproducers below, and every request ran on Claude Code 2.1.283 with `claude-opus-5-5`. The first answer had no thinking, the effort changed, the ledger rule calls the request a miss, and its valid timestamp is less than five minutes after the previous request's. Any other cache failure is an unexplained failure. The summary never reports a `KNOWN` scenario as a pass.

`context-effort-transition` and `context-partial-outage` keep their failing cache assertion. Their answers are text only, and on Claude Code 2.1.283 with Opus 5.5 each effort change re-caches the prefix. `context-effort-transition-reasoning` uses the same routing (low, low, xhigh, low) with prime-sum problems whose answers contain thinking. It must keep the cache, and it fails if its first answer has no thinking, because then it no longer tests that condition. `context-cache-control` keeps a fixed effort. See [Prompt cache and effort changes](#prompt-cache-and-effort-changes) and the [verification report](eval/results/2026-09-28-uncertainty-verification.md).

The runner exits 0 when every scenario passes, 1 when any other check fails, and 3 when the only failures are cache failures that match the observed pattern. Exit 3 is not a green run.

The E2E launcher disables Claude's server advisor for each test process with `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`. This keeps the evaluated model's work separate from a globally configured advisor. The normal `--tools` whitelist does not disable that server tool.

## Known limits

- A classifier request that hangs can't be cancelled, because Mods can't cancel `$.http.fetch`. The turn goes ahead after the timeout, but the abandoned request can delay the exit of a headless session by about 25 seconds.
- The usual level is learned per session. If a session's first turn already runs at a level set by hand and nothing is saved for the model, that level becomes the usual one.
- The threshold was calibrated on one person's prompts and one classifier.
- Shell and MCP inspection results are not collected. Without suitable evidence, the router retains the baseline or raises effort.
- Repository summaries refresh on a directory or session change. A changed README in the same session is reflected only if the agent reads it as task evidence.
- Recognizing instructions in tool evidence is a heuristic, not a complete defense against prompt injection.
- Checkpoints and logs add a file for every plugin instance of a session, after each reload or resume. Nothing deletes them, because another process may still write its own. A resume reads every checkpoint file of the conversation, so its reads grow with the number of reloads and resumes. The number of files never prevents a restore.
- Session-held state lasts only while the process runs and the conversation stays the same. A resume therefore relies on the checkpoints and never on the transcript, whose messages do not say where a prompt came from.

## License

MIT
