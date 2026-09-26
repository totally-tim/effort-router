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
- A model that takes an effort setting. On Anthropic's API and Claude subscriptions, Opus 5.5 keeps the prompt cache when the effort changes between requests, so a routed turn reads its prefix from cache. The e2e tests check this on Opus 5.5 only.

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
| `router: timeout`, `router: http 503`, `router: no API key` | The classifier gave no answer, so the turn kept the session's effort |
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

An option wins over the environment. The router posts to `<base URL>/v1/systemone` with `Authorization: Bearer <key>`. Its request holds only the fields of hosted Jev's contract (`model`, `state` and one `choice` question), so a service that adds fields of its own accepts it too.

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
| `logDir` | `~/.local/state/effort-router` | Where the decision logs go |
| `timeoutMs` | `5000` | How long enforce mode waits for the classifier |

Set options in `/config` under the plugin, or under `pluginConfigs` in settings.

## Where your prompts go

For each typed prompt, the router sends the classifier the prompt (up to 4,000 characters), the previous prompt and the start of the previous answer (up to 1,000 characters each), the two exchanges before those (up to 500 characters each), and counts of how the last turn went. With hosted Jev that is TypeSafe's service. Choose a self-hosted service if prompts must stay on your own hardware.

The decision log stays on your machine.

## How it decides

1. The first request of a turn asks the classifier with up to three contexts in parallel and averages the answers:
   - the prompt with the previous prompt and the start of the previous answer;
   - the same plus the two exchanges before those;
   - the same plus how the last turn went: failed tool calls, model requests, and whether you interrupted it.

   Identical request bodies are sent once, so a session's first turn makes one call.
2. The pick is the lowest level whose cumulative probability reaches the threshold. An uncertain answer therefore resolves to a higher level. Too little effort costs a retry, which costs more than extra thinking. max is never picked.
3. "ultrathink", "think hard", "think deeply" and "take your time" set a floor of xhigh.
4. A turn without a typed prompt, such as a background task finishing, gets the previous turn's level.
5. A message you type while a turn runs is classified too. It can raise the rest of the turn, never lower it. Queued prompts and messages nobody typed are left alone.
6. From the second failed tool call in a turn, the rest of the turn runs one level higher. From the fourth, it runs two levels higher.
7. Effort you set by hand wins. A turn whose effort differs from the session's usual level runs at that level, and routing resumes once the effort is back at the usual level. max always counts as set by hand. The usual level is the one saved for the model under `modelSettings`, else the first turn's level.
8. When something else changes effort mid-turn, such as a skill with `effort:`, the router leaves that request alone.
9. The router never changes a subagent's requests.

In enforce mode the first request of a turn waits up to 5 seconds for the classifier. Shadow mode never waits. When the classifier doesn't answer in time or fails, the turn keeps the session's effort. After three failures in a row the router stops asking for 5 minutes.

## Command

`/effort-router` also runs mid-turn.

| Argument | Effect |
|---|---|
| `status` (default) | Mode, range, threshold, the classifier and its health, the key, the last decision, and the log path |
| `why` | The full record of the last turn |
| `shadow`, `enforce`, `off` | Switches the mode for this session |
| `wrong <level>` | Labels the last turn with the level it should have had |

## Decision log

Each session writes `<logDir>/<session>.jsonl`. Every line is one turn or one label.

A turn record holds:
- the classifier's averaged probabilities and the pick;
- the usual level, and whether the effort was set by hand;
- each request's effort, seen and sent;
- any mid-turn raises;
- the number of failed tool calls;
- the turn's token usage;
- the first 200 characters of the prompt, so turns can be labeled later.

After a plugin reload the log keeps its earlier records.

## Evaluation

The threshold and the three-context ensemble come from an eval on 84 prompts typed in two weeks of one developer's interactive sessions. The classifier was a self-hosted service that serves Jev's System One contract, asked with the model name `jev-latest`. Four model labelers produced the truth, and the truth for each prompt is their median, with ties going to the higher level. The labelers agreed with each other exactly on 47 to 81% of prompts, and within one level on 90 to 100%.

At threshold 0.95 with the ensemble, the router picked too little effort on 8% of prompts and routed 54% of prompts below xhigh. The same developer had run 96% of requests at xhigh before.

Hosted Jev has not been measured. Its probabilities may be calibrated differently, so run the eval on your own prompts, or watch shadow mode for a while, before you enforce.

`eval/effort-eval.ts` runs with [Bun](https://bun.sh) and imports the mod's own request and pick code, so it asks exactly what the mod asks. Its data stays in `~/.local/state/effort-router/eval`.

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
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .   # checks the manifest and the plugin shape
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
bun e2e/e2e.ts [--model <id>] [scenario ...]                  # real headless sessions
```

The engine's API declarations under `.claude-plugin/types/` are committed, so the typecheck runs against the API surface the mod was written for. `claude plugin validate` refreshes them on Claude Code 2.1.283 and later.

`e2e/e2e.ts` runs real headless Claude Code sessions, each with its own log folder, and checks each request's effort in the transcript against the decision log. Most scenarios ask a local stand-in that holds requests to hosted Jev's contract: it refuses a wrong key, an unknown model and any field the contract does not have. Those scenarios cover the options and the environment variables, a rejected and a missing key, shadow mode, a classifier that is down or hangs, a launch effort set by hand, the headless default, off mode and a subagent. The `real-*` scenarios ask the classifier your `TYPESAFE_*` variables name, and check the prompt cache across a level change. They are skipped without `TYPESAFE_API_KEY`.

## Known limits

- A classifier request that hangs can't be cancelled, because Mods can't cancel `$.http.fetch`. The turn goes ahead after the timeout, but the abandoned request can delay the exit of a headless session by about 25 seconds.
- The usual level is learned per session. If a session's first turn already runs at a level set by hand and nothing is saved for the model, that level becomes the usual one.
- The threshold was calibrated on one person's prompts and one classifier.

## License

MIT
