# effort-router

effort-router is a Claude Code plugin that chooses reasoning effort for each turn. It uses your prompt, recent conversation, and inspected code to estimate how much reasoning the task needs. The spinner shows the effort sent with each request.

It starts in **shadow mode**, which logs recommendations without changing effort. **Enforce mode** applies them. The default classifier is [Jev](https://learnjev.com/reference) on TypeSafe's API; you can use a compatible System One service instead.

## Install

Requires Claude Code 2.1.283 or later and a model that supports effort. The Mods API is early access and may change between releases.

Merge this into `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "TYPESAFE_API_KEY": "<your key>"
  }
}
```

Then install:

```sh
claude plugin marketplace add totally-tim/effort-router
claude plugin install effort-router@effort-router
```

Start a new Claude session. Check the recommendations with `/effort-router`, then run `/effort-router enforce` to apply them for that session. Set `mode` to `enforce` under the plugin in `/config` to keep that setting.

To update, run these commands and start a new session:

```sh
claude plugin marketplace update effort-router
claude plugin update effort-router@effort-router
```

## Use

| Command | What it does |
|---|---|
| `/effort-router` | Shows mode, classifier health, last decision, cache counts, and log path |
| `/effort-router why` | Shows the last completed turn's full record |
| `/effort-router shadow` | Logs recommendations without applying them |
| `/effort-router enforce` | Applies recommendations |
| `/effort-router off` | Disables routing |
| `/effort-router wrong <level>` | Labels the last turn with the effort you expected |

The spinner and completed-turn line show the effort the router sent. Claude's built-in effort display still shows the session setting.

`router: needs context` means the classifier answered, but lacks evidence to justify lowering effort. A timeout or service error keeps at least the session effort. The router retries on later requests and pauses briefly after repeated failures; recovery does not require a restart.

## How it decides

The router chooses from `low`, `medium`, `high`, and `xhigh`. Missing context prevents it from lowering effort below the session's starting level. An ambiguous prompt such as "how does this work?" needs evidence about the code it refers to.

Reading code can resolve that uncertainty and allow a lower level before work begins. Once work begins, the router can only raise effort. Task continuations retain the prior task's effort floor. After `router: needs context`, that floor is the classifier's assessment, not the session effort that the router kept. Messages you send during a turn and repeated tool failures can also raise effort.

Manual effort overrides take precedence; `max` stays manual. The router leaves subagents alone. Routing for `claude -p` and SDK sessions is off unless you enable `headless`.

## Configuration

Set plugin options in `/config` or `pluginConfigs` in Claude settings. Explicit options override environment variables.

| Option | Environment variable | Default |
|---|---|---|
| `baseUrl` | `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` |
| `model` | `TYPESAFE_DEFAULT_MODEL` | `jev-latest` |
| `keyFile`, `keyName` | `TYPESAFE_API_KEY` | No key |

A key file can contain a plain token or a JSON object with the field named by `keyName`. Compatible classifiers must implement `POST /v1/systemone`.

The default range is `low` through `xhigh`, with a five-second classifier timeout. See the [plugin manifest](.claude-plugin/plugin.json) for all options and defaults.

## Data and privacy

The classifier receives limited excerpts of prompts, recent answers, repository summaries, and Read/Grep/Glob results. Hosted Jev sends these to TypeSafe. Use your own endpoint if that data must stay on your infrastructure.

The router filters credential paths and common token patterns, but cannot guarantee secret removal. It does not collect shell or MCP results directly; assistant answers can still repeat them.

Decision logs and resume checkpoints stay in `~/.local/state/effort-router`. They contain prompt and answer excerpts. Checkpoints omit tool output. Files accumulate without automatic deletion.

## Tests and evaluation

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
bun eval/replay-check.ts
bun e2e/e2e.ts
```

The E2E suite uses real Claude sessions and quota. Live classifier scenarios need `TYPESAFE_API_KEY`; the runner lists them as skipped when the key is absent.

See the [evaluation guide](eval/README.md) for replay and labeling, and the [implementation report](eval/results/2026-09-28-implementation.md) for results and remaining limits. Label agreement does not establish task success or cost savings; hosted Jev has not been evaluated.

Two known Claude cache failures remain. `/effort-router` reports observed misses, but a miss after an effort change does not prove the change caused it. The E2E runner exits `3` when only known cache failures occur, `1` for other failures, and `0` when all executed scenarios pass.

## License

[MIT](LICENSE)
