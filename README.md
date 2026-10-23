# pi-orchestra

An orchestrated sub-agent pipeline extension for the [pi coding agent](https://pi.dev).

```
parent session (orchestrate tool)
  │
  ├── plan-auditor ──── validates the plan is a concrete task list (not vague),
  │                    creates + maintains the progress tracker .md
  │
  └── per task, one by one:
        implementer ──► reviewer ──► APPROVED ──► plan-auditor marks it done in the tracker
             ▲              │                        next task
             └──────────────┘
        CHANGES_REQUESTED: parent re-assigns the implementer with the review notes,
        looping until approved or a guardrail trips
```

Every box is an isolated `pi --mode json --no-session` subprocess (the official subagent
extension pattern), so each agent has its own context window, model, and tool set.

## Install

```bash
pi install ./pi-orchestra
```

Then start pi (or run `/reload` in an active session). The `orchestrate` tool becomes available,
plus the `/run-plan` prompt template.

## Use

```
/run-plan PLAN.md
/run-plan "add a health endpoint to the API server"
```

Or ask directly, e.g. *"execute the tasks in docs/plan.md one by one"* — the model prepares the
task list and calls `orchestrate`:

```
orchestrate({
  tasks: [{ title: "...", description: "..." }, ...],
  maxReviewFailuresPerTask: 2,   // default 2
  maxTotalReviewFailures: 4,     // default 4
  trackerFile: "orchestra-tracker.md",  // default, relative to cwd
})
```

## The agents

| Agent | File | Tools | Role |
|---|---|---|---|
| implementer | `agents/implementer.md` | full (default set) + `scout` | implements exactly one task; escalates instead of hacking around a wrong task |
| reviewer | `agents/reviewer.md` | full (read-only discipline) + `scout` | verifies against the task, plan scope, and CLAUDE.md / AGENTS.md / intent.md; spots hot-fixes and anti-patterns; returns `VERDICT: APPROVED / CHANGES_REQUESTED / PLAN_ISSUE` |
| plan-auditor | `agents/plan-auditor.md` | read, write, edit, grep, find, ls, bash | validates plan concreteness; creates/updates the tracker markdown |
| scout | `agents/scout.md` | read, grep, find, ls | read-only recon for implementer/reviewer, returns compressed findings |

### Overriding agents

Agent files are markdown with frontmatter (`name`, `description`, `tools`, `model`, body =
system prompt). Precedence, later wins:

1. bundled — `<package>/agents/`
2. user — `~/.pi/agent/agents/`
3. project — `.pi/agents/` (nearest ancestor of the working directory)

Put a `reviewer.md` with `name: reviewer` in `~/.pi/agent/agents/` to change the reviewer's
model, tools, or instructions everywhere, or in a project's `.pi/agents/` for one repo.

**Model selection:** if an agent file sets `model:` in its frontmatter, that agent runs on it;
otherwise it inherits the parent session's model and thinking level. Set a cheap model on
`scout.md` for inexpensive recon, a strong one on `reviewer.md` for strict review.

**Tools:** the `tools` frontmatter applies to `scout` and `plan-auditor`. The implementer and
reviewer always keep the default tool selection so their `scout` tool stays available; constrain
them through their system prompts instead.

## Guardrails

The run stops and reports back for user intervention when:

| Stop reason | Trigger |
|---|---|
| `plan_vague` | plan-auditor returns `AUDIT: PLAN_VAGUE` — the plan is not a concrete task list |
| `plan_issue` | reviewer returns `VERDICT: PLAN_ISSUE` — the task itself is wrong/ambiguous/harmful |
| `review_budget_task` | a task failed review `maxReviewFailuresPerTask` times (default 2) |
| `review_budget_total` | the whole run accumulated `maxTotalReviewFailures` failed reviews (default 4) |
| `implementation_failed` | implementation or audit children kept crashing (model/auth/tooling errors) |
| `aborted` | the user aborted the run |

Progress is durable: the tracker file records every approved task, so a stopped or aborted run
can be resumed by re-running the remaining tasks.

## How it stays inside pi's model

- Children are spawned exactly like the official `subagent` example extension:
  `pi --mode json -p --no-session`, JSONL event parsing, abort via SIGTERM→SIGKILL,
  usage aggregation, `--append-system-prompt` from a `0600` temp file, and same-binary
  re-invocation.
- Children run with `--no-extensions` plus an explicit `--extension` pointing at this
  extension, so exactly one copy loads no matter how the package was installed.
- Role gating (`PI_ORCHESTRA_ROLE`): the parent session gets `orchestrate`; implementer and
  reviewer children get only `scout`; scouts and the plan-auditor get nothing (no recursion).
- Child usage is aggregated into the tool result's `usage` so session totals stay accurate.

## Security

- Everything runs with your credentials and permissions. Review agent files before installing
  overrides from a repository (`.pi/agents/` is repo-controlled content).
- The reviewer is instructed read-only; the implementer has full write access by design.

## Package layout

```
pi-orchestra/
├── package.json                  pi manifest (extension + prompt template)
├── extensions/orchestra/
│   ├── index.ts                  orchestrate + scout tools, subprocess runner, guardrails
│   └── agents.ts                 agent discovery (bundled → user → project)
├── agents/                       bundled agent personas
└── prompts/run-plan.md           /run-plan template
```
