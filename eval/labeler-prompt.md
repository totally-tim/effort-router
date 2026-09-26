Label each prompt in `sample.jsonl` (in the current directory) with an effort level. Write the result to `labels.jsonl` in the current directory. Do not read or write any other files.

`sample.jsonl` has 86 JSONL rows. Fields: `id`; `text`, the prompt a person typed into Claude Code (Opus 5.5) in an interactive session; `previous`, their previous prompt in the same session (may be absent).

Output: `labels.jsonl`, exactly one JSON object per input row, in the same order, nothing else in the file:
{"id": "<id>", "level": "low|medium|high|xhigh", "reason": "<one short line, max 15 words>"}

Question for each prompt: what is the LOWEST reasoning-effort level at which Opus 5.5 would most likely finish this request correctly on the first try?

Rubric:
- low: mechanical work. Run a known command, commit/push/merge a PR, rename, apply a known pattern across files, a lookup or status question, "reply OK", simple acknowledgements.
- medium: a well-scoped everyday change or question with clear scope (a small feature in a few files, a focused fix with a known cause, explaining how something works).
- high: needs more reading before writing. A change across several files or layers, debugging with an unclear cause, a fix that must reach every caller, a careful review.
- xhigh: hard or open-ended. Architecture or design decisions, novel problems, creative work, deep analysis or research, planning a multi-phase project, a security review with subtle reasoning.

Under-labeling costs a failed attempt and a retry, which is worse than over-labeling. When you are genuinely torn between two levels, choose the higher one. Short follow-ups ("yes", "do it", "continue", "go ahead") take the level the continued work needs; use `previous` to judge that.

Judge each prompt as written (plus `previous` for follow-ups). Do not open links or files that prompts mention. When you are done, reply only with the number of rows written and the count per level.
