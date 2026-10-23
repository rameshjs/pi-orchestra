---
description: Execute a plan or task through the orchestra pipeline (plan-audit → implement → review, with tracking and guardrails)
argument-hint: <plan file path, task list, or task description>
---
The user wants to execute: $@

Steps:

1. If $@ looks like a file path, read that file first and treat its contents as the plan.
2. Turn the request into a concrete, ordered task list. Each task must be specific and
   independently verifiable — if the request is vague or needs decisions the user has not made,
   ask the user now instead of calling any tool.
3. Call the `orchestrate` tool with `tasks: [{title, description}, ...]`. Optionally pass
   `trackerFile` if the user wants the progress tracker at a specific path.
4. When orchestrate returns, report to the user: which tasks were approved, any stop reason
   (vague plan, plan issue, review budgets), the review notes if changes were requested, and
   the tracker file path.

Do not implement the tasks yourself — the orchestrate tool delegates to implementer and reviewer
sub-agents. Do not re-run orchestrate automatically after a guardrail stop; the user must decide.
