# Why needs-context appears often

Investigated September 27, 2026, against effort-router v0.3.0 at `9177419`.
Production code and settings were unchanged. The investigation used the Railway
migration, HerdApp, and Boat/Factorio sessions, plus local-decide replays and two
isolated plugin tests. The [JSON receipt](2026-09-27-needs-context.json) records
the measurements.

## Observed frequency and effect

The frozen sample contains 38 completed turns with context-assessment fields.
It excludes transport failures and older records without those fields. Thirteen
turns ended with `insufficient context`. Those turns contained 494 of the
sample's 927 model requests, so the label can occupy much more screen time than
its turn count suggests. These are request counts for whole turns, not a record
of every spinner update.

| Session | Completed turns | Ended with needs-context | Model requests in those turns |
|---|---|---|---|
| Railway migration | 24 | 6 | 180 |
| HerdApp | 6 | 4 | 220 |
| Boat/Factorio | 8 | 3 | 94 |

In nine of the thirteen flagged turns, the recorded effort and work
probabilities already selected xhigh at the configured 95% threshold. The
context guard did not raise their selected level. Four flagged turns did
increase effort: three from medium to xhigh and one from high to xhigh.
This calculation isolates the context guard; it does not evaluate whether the
underlying effort scores were correct.

## Causes

### The router misses much of the agent's working context

Thirty-three of the 38 turns recorded no eligible tool evidence. The collector
accepts successful Read content and matching Grep content. Glob is a hint.
Shell and MCP output are excluded, and attached images are not in the classifier
request. Only four observations survive, each limited to 1,600 characters.

Railway and Boat run from the home directory, where none of the four files used
for the repository summary exist. Their summaries are therefore empty. The
collector does not use shell output to identify a repository elsewhere.

The Railway turn beginning with "surface me all open questions via
userquestiontool" ran 149 model requests. Its initial decision reported
`missing_target`. Its one discovery check saw a runbook and reported
`uncertain_context`. The classifier answered in 276 and 326 ms. The record
confirms an evidence problem after the outage had recovered.

### Background notifications replace the remembered task

Every completed nonempty turn updates `previousTask`, including
`<task-notification>` messages. The same turns enter the three-exchange history.
Answers in that history retain only their first 1,000 characters; older variants
receive still shorter excerpts.

Before Railway's "logged in again", the immediately preceding turn was an image
transfer notification. The router's main task reference described deployment
progress rather than the pending login step. An isolated plugin test reproduced
this replacement with a synthetic migration, a volume-copy notification, and a
login confirmation.

### One uncertain variant vetoes the context assessment

The classifier receives three variants: the previous exchange, the same input
with older exchanges, and the same input with the previous turn's request and
error counts. Each answered variant must select `sufficient` with probability
at least 0.8. All must pass.

For the reconstructed Railway question "what else is missing or all migrations
done?", sufficient-context probabilities were 0.97, 0.98, and 0.32. The last
variant added one failed tool call and fifteen model requests, with the matching
instruction about previous-turn difficulty. Its failure vetoed the other two
assessments and retained xhigh. The experiment changed both that field and its
instruction, so it does not isolate which caused the score change.

The log label `uncertain_context` can mean the model selected `sufficient` but
assigned it less than 0.8 probability. It does not necessarily mean the model
selected a missing-context category.

### The label can overstate or outlive the context guard

The policy selects the `insufficient context` reason whenever its context check
fails, even if the effort scores already require xhigh. That explains the nine
flagged turns where the guard did not change the selected level.

There is also a reproducible stale-label defect. After an action, discovery is
allowed to raise effort but cannot lower it. If later evidence is sufficient
and its level is unchanged or lower, the code keeps the earlier reason and
top-level context fields. The spinner can keep saying needs-context while the
discovery record says context is sufficient. An isolated test reproduced this
with a Bash call followed by a successful Read. No matching case was found in
the completed live logs inspected here; this is a confirmed possible cause,
not an attribution for those recorded turns.

Discovery has only two classifier checks per turn. Long tasks can use both
before reaching the useful source. Later user messages can raise effort but do
not replace the initial task text or clear its context label.

## Live diagnostic replay

Three short Railway prompts were reconstructed from the decision logs and
transcripts. The second arm added a manually prepared summary of the ongoing
task. Both arms used the current request builder and local-decide. Eighteen
classifier calls completed, with measured latencies between 264 and 421 ms.

| Request | Reconstructed context | With task summary |
|---|---|---|
| "i logged you in" | Context failed; xhigh | Context sufficient; high |
| "logged in again" | Context failed; xhigh | Context sufficient; xhigh retained by continuation |
| "what else is missing or all migrations done?" | Context failed; xhigh | Context still uncertain; xhigh |

The summary resolved both login cases. It did not overcome the third variant's
low context score for the status question. This is a small diagnostic with one
replay per arm. The original HTTP bodies were not logged, so the reconstructed
inputs are not exact historical reproductions. The summary arm is not evidence
that an automatic summarizer would produce the same facts or results.

## Recommended changes

1. Keep the user's ongoing task and pending question across background
   notifications. Store notification updates separately from the task reference.
2. Update context status independently of whether effort can change. Distinguish
   a context guard that actually retains a higher level from ordinary hard work.
3. Supply bounded, sanitized task findings for shell and MCP workflows. Evaluate
   data filtering before sending more tool output to the classifier.
4. Reevaluate the all-variants context veto separately from the effort ensemble.
   Prior-turn request counts and tool errors can inform effort without serving
   as independent vetoes on whether the target is known.

The context safeguard still addresses the original toy-repository versus kernel
problem. Changes to it need the paired-context and historical evaluations before
deployment. This investigation identifies causes; it does not change the routing
policy or establish a new calibrated threshold.
