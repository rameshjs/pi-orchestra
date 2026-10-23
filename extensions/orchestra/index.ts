/**
 * pi-orchestra — orchestrated sub-agent pipeline for the pi coding agent.
 *
 * Flow (each box below is an isolated `pi --mode json` subprocess, following
 * the official subagent extension pattern):
 *
 *   parent session (orchestrate tool)
 *     ├── plan-auditor   — validates the plan is a concrete task list (not vague),
 *     │                    creates and maintains the tracker .md file
 *     └── per task, one by one:
 *           ├── implementer  — implements exactly one task (has `scout` tool)
 *           └── reviewer     — reviews against task, plan, and repo guidelines
 *                              (CLAUDE.md / AGENTS.md / intent.md); has `scout` tool
 *               └─ CHANGES_REQUESTED → parent re-assigns implementer with review
 *                  notes until APPROVED, bounded by guardrails
 *
 * Guardrails (stop and ask the user):
 *   - plan judged vague by the plan-auditor
 *   - reviewer returns PLAN_ISSUE (the task itself is wrong)
 *   - per-task failed-review budget exhausted (default 2)
 *   - total failed-review budget exhausted (default 4)
 *
 * Role gating: children are spawned with PI_ORCHESTRA_ROLE set. The extension
 * factory reads it so that:
 *   - no role (parent session)      → registers `orchestrate`
 *   - implementer / reviewer child  → registers `scout` only
 *   - scout grandchild              → registers nothing (no recursion)
 *
 * Children are spawned with `--no-extensions` plus an explicit `--extension`
 * (the extension's own path) where needed, so exactly one copy loads
 * regardless of how the user installed the package.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLE_ENV = "PI_ORCHESTRA_ROLE";
type Role = "implementer" | "reviewer" | "plan-auditor" | "scout";

const MAX_TASKS = 12;
const MAX_ATTEMPT_PROMPT_CHARS = 24 * 1024;
const NOTES_CAP = 12 * 1024;
const SCOUT_OUTPUT_CAP = 30 * 1024;
const ABORT_KILL_GRACE_MS = 5000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = path.join(__dirname, "index.ts");
const BUNDLED_AGENTS_DIR = path.resolve(__dirname, "../../agents");

const DEFAULT_TRACKER_FILE = "orchestra-tracker.md";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const EMPTY_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

interface ChildRun {
	role: Role;
	agent: string;
	ok: boolean;
	exitCode: number;
	finalText: string;
	messages: Message[];
	usage: UsageTotals;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
}

type Verdict = "APPROVED" | "CHANGES_REQUESTED" | "PLAN_ISSUE";
type AuditVerdict = "PLAN_OK" | "PLAN_VAGUE";

type TaskStatus = "pending" | "in_progress" | "approved" | "failed" | "skipped";

interface TaskState {
	index: number;
	title: string;
	description: string;
	status: TaskStatus;
	attempts: number;
	failures: number;
	lastVerdict?: string;
	lastReviewNotes?: string;
	implReport?: string;
}

interface OrchestraDetails {
	phase: string;
	tasks: TaskState[];
	trackerFile?: string;
	stopReason?: string;
	stopMessage?: string;
	totalUsage: UsageTotals;
	childRuns: number;
}

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of (msg as any).content ?? []) {
				if (part.type === "text") return part.text as string;
			}
		}
	}
	return "";
}

function truncateText(text: string, cap: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= cap) return text;
	let truncated = text.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[... truncated, ${bytes - Buffer.byteLength(truncated, "utf8")} bytes omitted]`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageTotals, model?: string): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function addUsage(target: UsageTotals, source: UsageTotals): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
}

/** Re-invoke the same pi binary whenever possible (same version, same install). */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/** Write a long system prompt to a private temp file (avoids shell quoting). */
async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orchestra-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

const VERDICT_TOKENS = ["APPROVED", "CHANGES_REQUESTED", "PLAN_ISSUE"] as const;
const AUDIT_TOKENS = ["PLAN_OK", "PLAN_VAGUE"] as const;

/**
 * Find the verdict in a reviewer report. The reviewer is instructed to end
 * with `VERDICT: <token>`, but be tolerant: last occurrence of either the
 * prefixed form or a bare token wins.
 */
function parseVerdict(text: string): Verdict | undefined {
	const prefixed = [...text.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED|PLAN_ISSUE)/gi)];
	if (prefixed.length > 0) return prefixed[prefixed.length - 1][1].toUpperCase() as Verdict;

	let best: { token: Verdict; pos: number } | undefined;
	for (const token of VERDICT_TOKENS) {
		const pos = text.toUpperCase().lastIndexOf(token);
		if (pos >= 0 && (!best || pos > best.pos)) best = { token, pos };
	}
	return best?.token;
}

function parseAuditVerdict(text: string): AuditVerdict | undefined {
	const prefixed = [...text.matchAll(/AUDIT:\s*(PLAN_OK|PLAN_VAGUE)/gi)];
	if (prefixed.length > 0) return prefixed[prefixed.length - 1][1].toUpperCase() as AuditVerdict;

	let best: { token: AuditVerdict; pos: number } | undefined;
	for (const token of AUDIT_TOKENS) {
		const pos = text.toUpperCase().lastIndexOf(token);
		if (pos >= 0 && (!best || pos > best.pos)) best = { token, pos };
	}
	return best?.token;
}

// ---------------------------------------------------------------------------
// Child process runner (the core subprocess pattern from the official example)
// ---------------------------------------------------------------------------

interface RunChildOptions {
	role: Role;
	agent: AgentConfig;
	prompt: string;
	cwd: string;
	defaults: DispatchDefaults;
	signal?: AbortSignal;
	/** Load this extension in the child (implementer/reviewer need the scout tool). */
	loadSelf?: boolean;
	onUpdate?: (partial: ChildRun) => void;
}

async function runChild(opts: RunChildOptions): Promise<ChildRun> {
	const { agent, role } = opts;

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];

	if (opts.loadSelf) args.push("--extension", SELF_PATH);

	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? opts.defaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && opts.defaults.thinkingLevel) {
		args.push("--thinking", opts.defaults.thinkingLevel);
	}

	// Only pass an explicit tool list for roles that do not need extension
	// tools (scout, plan-auditor). implementer/reviewer keep the default
	// selection so the `scout` tool registered by the extension stays declared.
	if (agent.tools && agent.tools.length > 0 && !opts.loadSelf) {
		args.push("--tools", agent.tools.join(","));
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const result: ChildRun = {
		role,
		agent: agent.name,
		ok: false,
		exitCode: 0,
		finalText: "",
		messages: [],
		usage: { ...EMPTY_USAGE },
		stderr: "",
	};

	const emitUpdate = () => {
		opts.onUpdate?.({ ...result, messages: [...result.messages] });
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(truncateText(opts.prompt, MAX_ATTEMPT_PROMPT_CHARS));

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [ROLE_ENV]: role },
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						const usage = (msg as any).usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
						}
						if (!result.model && (msg as any).model) result.model = (msg as any).model;
						if ((msg as any).stopReason) result.stopReason = (msg as any).stopReason;
						if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;
					}
					result.finalText = getFinalOutput(result.messages);
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (opts.signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, ABORT_KILL_GRACE_MS);
				};
				if (opts.signal.aborted) killProc();
				else opts.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.ok = exitCode === 0 && !wasAborted && result.stopReason !== "error" && result.stopReason !== "aborted";
		if (wasAborted) result.errorMessage = "Subagent was aborted";
		return result;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function planContextList(tasks: TaskState[], currentIndex: number): string {
	return tasks
		.map((t) => {
			const marker = t.index === currentIndex ? "  <-- CURRENT TASK" : "";
			return `${t.index}. ${t.title}${marker}`;
		})
		.join("\n");
}

function buildImplementerPrompt(task: TaskState, tasks: TaskState[], attempt: number, reviewNotes: string | undefined): string {
	const parts: string[] = [];
	parts.push(`## Task ${task.index}/${tasks.length}: ${task.title}`);
	parts.push(task.description);
	parts.push("");
	parts.push("## Plan context (all tasks; implement ONLY the current one)");
	parts.push(planContextList(tasks, task.index));
	parts.push("");
	parts.push("## Working directory");
	parts.push(process.cwd());
	if (attempt > 1 && reviewNotes) {
		parts.push("");
		parts.push(`## Review notes from your previous attempt (attempt ${attempt - 1}) — address every point`);
		parts.push(reviewNotes);
	}
	parts.push("");
	parts.push(
		"Implement the current task completely and correctly. Use the scout tool to explore the codebase before coding. " +
			"Check for guideline files (CLAUDE.md, AGENTS.md, intent.md) and follow them. " +
			"When you are done, output your report in the format your instructions specify.",
	);
	return parts.join("\n");
}

function buildReviewerPrompt(task: TaskState, tasks: TaskState[], attempt: number, implReport: string): string {
	const parts: string[] = [];
	parts.push(`## Task under review: ${task.title} (task ${task.index}/${tasks.length}, implementation attempt ${attempt})`);
	parts.push(task.description);
	parts.push("");
	parts.push("## Plan context");
	parts.push(planContextList(tasks, task.index));
	parts.push("");
	parts.push("## Implementer report");
	parts.push(implReport || "(implementer produced no report)");
	parts.push("");
	parts.push("## Working directory");
	parts.push(process.cwd());
	parts.push("");
	parts.push(
		"Review this implementation per your instructions: verify the work against the task, the plan scope, and repo " +
			"guideline files (CLAUDE.md, AGENTS.md, intent.md). Look for hot-fixes, anti-patterns, and deviations. " +
			"End your report with the VERDICT line.",
	);
	return parts.join("\n");
}

function buildPlanValidatePrompt(tasks: TaskState[], trackerFile: string, cwd: string): string {
	const parts: string[] = [];
	parts.push("Mode: VALIDATE");
	parts.push("");
	parts.push("## Plan to validate");
	parts.push(tasks.map((t) => `${t.index}. ${t.title}\n   ${t.description}`).join("\n"));
	parts.push("");
	parts.push("## Working directory");
	parts.push(cwd);
	parts.push("");
	parts.push("## Tracker file to create / initialize");
	parts.push(trackerFile);
	parts.push("");
	parts.push(
		"Do two things:\n" +
			"1. Judge whether this plan is a concrete, executable task list — not a vague goal. Each task must be " +
			"specific, independently verifiable, and implementable without information the implementer does not have. " +
			"Tasks like \"improve X\", \"make it better\", or \"refactor\" without concrete targets make the plan vague.\n" +
			"2. Create or initialize the tracker file at the path above: a human-readable markdown checklist of all " +
			"tasks, each with status `pending`. Review the working directory first so the tracker reflects reality.\n\n" +
			"End with exactly one line: `AUDIT: PLAN_OK` or `AUDIT: PLAN_VAGUE`. If PLAN_VAGUE, list precisely what is " +
			"vague and what the user must clarify.",
	);
	return parts.join("\n");
}

function buildPlanUpdatePrompt(completed: TaskState[], trackerFile: string, cwd: string): string {
	const parts: string[] = [];
	parts.push("Mode: UPDATE");
	parts.push("");
	parts.push("## Tasks just completed and approved by review");
	parts.push(completed.map((t) => `${t.index}. ${t.title}\n   Implementer summary: ${t.implReport || "(none)"}`).join("\n"));
	parts.push("");
	parts.push("## Tracker file to update");
	parts.push(trackerFile);
	parts.push("");
	parts.push("## Working directory");
	parts.push(cwd);
	parts.push("");
	parts.push(
		"Update the tracker file: mark the completed tasks (status `completed`, with a short note from the implementer " +
			"summary). Verify against the repository (read-only) if useful. Do not alter unrelated entries. " +
			"End with exactly one line: `AUDIT: PLAN_OK`.",
	);
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

const STOP_GUIDANCE: Record<string, string> = {
	plan_vague:
		"The plan was judged too vague to execute safely. Refine it into concrete, verifiable tasks (or answer the auditor's questions), then run again.",
	plan_issue:
		"The reviewer flagged the task or plan itself as wrong or ambiguous — this is not an implementation quality problem. Read the reviewer notes and make a decision, then re-run.",
	review_budget_task:
		"This task failed review too many times. Inspect the review notes and the tracker file, adjust the task or the approach, and re-run the remaining tasks.",
	review_budget_total:
		"The total failed-review budget for this run is exhausted. Review the tracker and the notes before continuing — repeated failures usually mean the plan or the task decomposition needs a human decision.",
	implementation_failed:
		"Implementation kept failing at the process level (crash, model error, or auth). Check the model configuration and credentials, then re-run.",
	aborted: "The run was aborted. Completed tasks are marked in the tracker file; re-run to continue with the remaining tasks.",
};

function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "approved":
			return "✓";
		case "failed":
			return "✗";
		case "in_progress":
			return "◐";
		case "skipped":
			return "⊘";
		default:
			return "○";
	}
}

function buildReportText(details: OrchestraDetails): string {
	const lines: string[] = [];
	const approved = details.tasks.filter((t) => t.status === "approved").length;

	lines.push(`## Orchestra Report`);
	lines.push(`Tasks approved: ${approved}/${details.tasks.length}`);
	for (const t of details.tasks) {
		lines.push("");
		lines.push(`### ${statusIcon(t.status)} [${t.index}] ${t.title}`);
		const bits: string[] = [`status: ${t.status}`];
		if (t.attempts) bits.push(`attempts: ${t.attempts}`);
		if (t.failures) bits.push(`review failures: ${t.failures}`);
		if (t.lastVerdict && t.status !== "approved") bits.push(`last verdict: ${t.lastVerdict}`);
		lines.push(bits.join(", "));
		if (t.status === "failed" && t.lastReviewNotes) {
			lines.push("");
			lines.push("Last review notes:");
			lines.push(truncateText(t.lastReviewNotes, NOTES_CAP));
		}
	}

	if (details.stopReason) {
		lines.push("");
		lines.push("## ⚠ Stopped — user review needed");
		lines.push(`Reason: ${details.stopReason}`);
		if (details.stopMessage) lines.push(details.stopMessage);
		const guidance = STOP_GUIDANCE[details.stopReason];
		if (guidance) {
			lines.push("");
			lines.push(guidance);
		}
	}

	if (details.trackerFile) {
		lines.push("");
		lines.push(`Progress tracker: ${details.trackerFile}`);
	}

	const usage = formatUsage(details.totalUsage);
	if (usage) {
		lines.push("");
		lines.push(`Total usage: ${usage} across ${details.childRuns} child agents`);
	}

	return lines.join("\n");
}

function progressText(details: OrchestraDetails): string {
	const current = details.tasks.find((t) => t.status === "in_progress");
	const approved = details.tasks.filter((t) => t.status === "approved").length;
	const where = current ? `[${current.index}] ${current.title}` : "…";
	return `orchestra: ${details.phase} — ${approved}/${details.tasks.length} approved — ${where}`;
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	title: Type.String({ description: "Short, imperative task title" }),
	description: Type.String({ description: "Concrete description of what to implement and what done means" }),
});

const OrchestraParams = Type.Object({
	task: Type.Optional(Type.String({ description: "A single task to execute through the pipeline" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Ordered task list to execute one by one" })),
	trackerFile: Type.Optional(
		Type.String({ description: `Path for the progress tracker markdown. Default: ${DEFAULT_TRACKER_FILE} in the working directory` }),
	),
	maxReviewFailuresPerTask: Type.Optional(
		Type.Number({ description: "Guardrail: max failed review cycles per task before stopping. Default: 2" }),
	),
	maxTotalReviewFailures: Type.Optional(
		Type.Number({ description: "Guardrail: max total failed reviews across the run. Default: 4" }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the pipeline (defaults to session cwd)" })),
});

const ScoutParams = Type.Object({
	query: Type.String({ description: "What to investigate in the codebase" }),
	thoroughness: Type.Optional(
		StringEnum(["quick", "medium", "thorough"] as const, {
			description: "How deep to investigate. Default: medium",
			default: "medium",
		}),
	),
});

// ---------------------------------------------------------------------------
// Tool: orchestrate (parent session only)
// ---------------------------------------------------------------------------

const orchestrateTool = {
	name: "orchestrate",
	label: "Orchestra",
	description: [
		"Execute a task or an ordered task list through an orchestrated pipeline:",
		"plan-auditor validates the plan and creates a progress tracker file, then each task runs",
		"implementer → reviewer in a loop (review notes are fed back to the implementer until approved).",
		"Guardrails stop the run for user review when the plan is vague, the reviewer flags the plan itself,",
		"or review-failure budgets are exceeded. Only pass concrete, verifiable tasks — not vague goals.",
	].join(" "),
	promptGuidelines: [
		"Use orchestrate when the user wants a plan or task list executed end to end. Prepare a concrete, verifiable task list first; if the request is vague, ask the user instead of calling orchestrate.",
		"After orchestrate returns, report the outcome to the user: approved tasks, any stop reason, review notes, and the tracker file path.",
	],
	parameters: OrchestraParams,

	async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
		const cwd = params.cwd ?? ctx.cwd;
		const defaults: DispatchDefaults = {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: ctx.thinkingLevel,
		};

		const discovery = discoverAgents(cwd, BUNDLED_AGENTS_DIR);
		const agents = discovery.agents;
		const findAgent = (name: string) => agents.find((a) => a.name === name);

		// --- normalize input -------------------------------------------------
		let rawTasks: Array<{ title: string; description: string }>;
		if (params.tasks && params.tasks.length > 0) {
			rawTasks = params.tasks;
		} else if (params.task) {
			const firstLine = params.task.split("\n")[0].trim().slice(0, 80);
			rawTasks = [{ title: firstLine || "Task", description: params.task }];
		} else {
			return {
				content: [{ type: "text", text: "Invalid parameters: provide `task` (single) or `tasks` (list)." }],
				details: undefined,
			};
		}
		if (rawTasks.length > MAX_TASKS) {
			return {
				content: [{ type: "text", text: `Too many tasks (${rawTasks.length}). Max is ${MAX_TASKS}.` }],
				details: undefined,
			};
		}

		const tasks: TaskState[] = rawTasks.map((t, i) => ({
			index: i + 1,
			title: t.title || `Task ${i + 1}`,
			description: t.description || t.title || "",
			status: "pending" as TaskStatus,
			attempts: 0,
			failures: 0,
		}));

		const trackerFile = path.resolve(cwd, params.trackerFile ?? DEFAULT_TRACKER_FILE);
		const maxPerTask = Math.max(1, params.maxReviewFailuresPerTask ?? 2);
		const maxTotal = Math.max(1, params.maxTotalReviewFailures ?? 4);

		const details: OrchestraDetails = {
			phase: "validating-plan",
			tasks,
			trackerFile,
			totalUsage: { ...EMPTY_USAGE },
			childRuns: 0,
		};

		const emit = () => {
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: progressText(details) }],
					details: { ...details, tasks: details.tasks.map((t) => ({ ...t })), totalUsage: { ...details.totalUsage } },
				});
			}
		};

		const run = async (o: RunChildOptions) => {
			details.childRuns++;
			const res = await runChild(o);
			addUsage(details.totalUsage, res.usage);
			emit();
			return res;
		};

		const missing = ["implementer", "reviewer", "plan-auditor"].filter((n) => !findAgent(n));
		if (missing.length > 0) {
			return {
				content: [{ type: "text", text: `Missing agent definitions: ${missing.join(", ")}. Check the agents directories.` }],
				details: undefined,
			};
		}

		let totalFailures = 0;
		let stop: { reason: string; message?: string } | null = null;
		emit();

		// --- phase 1: plan validation + tracker creation ----------------------
		const auditor = findAgent("plan-auditor")!;
		const auditRun = await run({
			role: "plan-auditor",
			agent: auditor,
			prompt: buildPlanValidatePrompt(tasks, trackerFile, cwd),
			cwd,
			defaults,
			signal,
			onUpdate: (partial) => {
				details.phase = `validating-plan (${partial.finalText ? "auditing" : "starting"})`;
				emit();
			},
		});

		if (auditRun.ok) {
			const auditVerdict = parseAuditVerdict(auditRun.finalText);
			if (auditVerdict === "PLAN_VAGUE") {
				stop = { reason: "plan_vague", message: `Plan-auditor notes:\n${truncateText(auditRun.finalText, NOTES_CAP)}` };
			} else if (!auditVerdict) {
				// A parse failure is not evidence of vagueness; continue with a warning.
				details.stopMessage = `Warning: plan-auditor verdict could not be parsed; continuing.\n${truncateText(auditRun.finalText, 2048)}`;
			}
		} else {
			stop = {
				reason: "implementation_failed",
				message: `Plan-auditor run failed: ${auditRun.errorMessage || auditRun.stderr || "unknown error"}`,
			};
		}

		// --- phase 2: implement → review loop, one task at a time -------------
		if (!stop) {
			const implementer = findAgent("implementer")!;
			const reviewer = findAgent("reviewer")!;

			outer: for (const task of tasks) {
				if (stop || signal?.aborted) {
					if (!stop && signal?.aborted) stop = { reason: "aborted", message: "Run aborted by the user." };
					break;
				}

				task.status = "in_progress";
				let reviewNotes: string | undefined;

				while (true) {
					if (signal?.aborted) {
						task.status = "skipped";
						stop = { reason: "aborted", message: "Run aborted by the user." };
						break outer;
					}
					const attempt = task.attempts + 1;
					task.attempts = attempt;

					// --- implement ---
					details.phase = `implementing task ${task.index} (attempt ${attempt})`;
					emit();
					const implRun = await run({
						role: "implementer",
						agent: implementer,
						prompt: buildImplementerPrompt(task, tasks, attempt, reviewNotes),
						cwd,
						defaults,
						signal,
						loadSelf: true,
						onUpdate: (partial) => {
							details.phase = `implementing task ${task.index} (attempt ${attempt})`;
							task.implReport = partial.finalText || task.implReport;
							emit();
						},
					});

					if (!implRun.ok) {
						task.failures++;
						totalFailures++;
						reviewNotes = `Previous implementation attempt failed at the process level: ${implRun.errorMessage || implRun.stderr || "unknown error"}. Retry the full task.`;
						if (task.failures >= maxPerTask) {
							stop = { reason: "implementation_failed", message: `Task [${task.index}] ${task.title}: implementation kept failing.` };
							task.status = "failed";
							break outer;
						}
						if (totalFailures >= maxTotal) {
							stop = { reason: "review_budget_total", message: "Total failure budget exhausted during implementation." };
							task.status = "failed";
							break outer;
						}
						continue; // retry implementer with the error as notes
					}

					task.implReport = implRun.finalText;

					// --- review ---
					details.phase = `reviewing task ${task.index} (attempt ${attempt})`;
					emit();
					const revRun = await run({
						role: "reviewer",
						agent: reviewer,
						prompt: buildReviewerPrompt(task, tasks, attempt, implRun.finalText),
						cwd,
						defaults,
						signal,
						loadSelf: true,
						onUpdate: (partial) => {
							details.phase = `reviewing task ${task.index} (attempt ${attempt})`;
							task.lastReviewNotes = partial.finalText || task.lastReviewNotes;
							emit();
						},
					});

					if (!revRun.ok) {
						// Reviewer crash: counts as a failed review cycle.
						task.failures++;
						totalFailures++;
						task.lastVerdict = "REVIEW_ERROR";
						task.lastReviewNotes = `Reviewer run failed: ${revRun.errorMessage || revRun.stderr || "unknown error"}`;
						if (task.failures >= maxPerTask) {
							stop = { reason: "review_budget_task", message: `Task [${task.index}] exhausted its review budget (reviewer errors).` };
							task.status = "failed";
							break outer;
						}
						if (totalFailures >= maxTotal) {
							stop = { reason: "review_budget_total", message: "Total failure budget exhausted (reviewer errors)." };
							task.status = "failed";
							break outer;
						}
						reviewNotes = task.lastReviewNotes;
						continue; // retry implementer (fresh attempt) — reviewer will re-run after it
					}

					const verdict = parseVerdict(revRun.finalText) ?? "CHANGES_REQUESTED";
					task.lastVerdict = verdict;
					task.lastReviewNotes = revRun.finalText;

					if (verdict === "APPROVED") {
						task.status = "approved";
						details.phase = `updating tracker after task ${task.index}`;
						emit();

						// --- tracker update (best effort; a failure here must not lose work) ---
						const updateRun = await run({
							role: "plan-auditor",
							agent: auditor,
							prompt: buildPlanUpdatePrompt([task], trackerFile, cwd),
							cwd,
							defaults,
							signal,
						});
						if (!updateRun.ok) {
							details.stopMessage = `Warning: tracker update after task ${task.index} failed (${updateRun.errorMessage || "unknown error"}).`;
						}
						continue outer; // next task
					}

					if (verdict === "PLAN_ISSUE") {
						task.status = "failed";
						stop = {
							reason: "plan_issue",
							message: `Reviewer flagged the task itself. Task [${task.index}] ${task.title}. Reviewer notes:\n${truncateText(revRun.finalText, NOTES_CAP)}`,
						};
						break outer;
					}

					// CHANGES_REQUESTED → guardrails, then retry with notes
					task.failures++;
					totalFailures++;
					reviewNotes = revRun.finalText;
					if (task.failures >= maxPerTask) {
						task.status = "failed";
						stop = { reason: "review_budget_task", message: `Task [${task.index}] ${task.title} failed review ${task.failures} times.` };
						break outer;
					}
					if (totalFailures >= maxTotal) {
						task.status = "failed";
						stop = { reason: "review_budget_total", message: `Total failed reviews reached ${totalFailures}.` };
						break outer;
					}
					// loop: implementer re-runs with review notes
				}
			}
		}

		// --- finalize ---------------------------------------------------------
		for (const t of tasks) {
			if (t.status === "pending" || t.status === "in_progress") t.status = stop ? "skipped" : t.status;
		}
		details.phase = stop ? "stopped" : "done";
		if (stop) {
			details.stopReason = stop.reason;
			details.stopMessage = stop.message;
		}
		emit();

		const report = buildReportText(details);
		return {
			content: [{ type: "text", text: report }],
			details,
			usage: {
				input: details.totalUsage.input,
				output: details.totalUsage.output,
				cacheRead: details.totalUsage.cacheRead,
				cacheWrite: details.totalUsage.cacheWrite,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: details.totalUsage.cost },
			},
		};
	},

	renderCall(args: any, theme: any) {
		const guard = `max ${args.maxReviewFailuresPerTask ?? 2}/task, ${args.maxTotalReviewFailures ?? 4} total`;
		if (args.tasks && args.tasks.length > 0) {
			let text =
				theme.fg("toolTitle", theme.bold("orchestra ")) +
				theme.fg("accent", `${args.tasks.length} tasks`) +
				theme.fg("muted", ` [${guard}]`);
			for (const t of args.tasks.slice(0, 3)) {
				const preview = t.title.length > 50 ? `${t.title.slice(0, 50)}...` : t.title;
				text += `\n  ${theme.fg("muted", "·")} ${theme.fg("accent", preview)}`;
			}
			if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
			return new Text(text, 0, 0);
		}
		const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
		return new Text(
			theme.fg("toolTitle", theme.bold("orchestra ")) + theme.fg("accent", "single task") + theme.fg("muted", ` [${guard}]`) + `\n  ${theme.fg("dim", preview)}`,
			0,
			0,
		);
	},

	renderResult(result: any, options: any, theme: any) {
		const details: OrchestraDetails | undefined = result.details;
		if (!details || details.tasks.length === 0) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		}
		const expanded = options?.expanded;
		const mdTheme = getMarkdownTheme();
		const approved = details.tasks.filter((t) => t.status === "approved").length;

		const headerIcon = details.stopReason
			? theme.fg("error", "✗")
			: approved === details.tasks.length
				? theme.fg("success", "✓")
				: theme.fg("warning", "◐");
		const header =
			headerIcon +
			" " +
			theme.fg("toolTitle", theme.bold("orchestra ")) +
			theme.fg("accent", `${approved}/${details.tasks.length} approved`) +
			(details.stopReason ? theme.fg("error", ` — stopped: ${details.stopReason}`) : theme.fg("muted", ` — ${details.phase}`));

		if (expanded) {
			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			for (const t of details.tasks) {
				const icon = statusIcon(t.status) === "✓" ? theme.fg("success", "✓") : statusIcon(t.status) === "✗" ? theme.fg("error", "✗") : theme.fg("muted", statusIcon(t.status));
				container.addChild(
					new Text(
						`${icon} ${theme.fg("accent", `[${t.index}] ${t.title}`)}${theme.fg("muted", ` — ${t.status}${t.attempts ? `, ${t.attempts} attempt(s)` : ""}`)}`,
						0,
						0,
					),
				);
				if (t.lastVerdict && t.status !== "approved") {
					container.addChild(new Text(theme.fg("dim", `    verdict: ${t.lastVerdict}`), 0, 0));
				}
				if (expanded && t.lastReviewNotes && t.status === "failed") {
					container.addChild(new Markdown(truncateText(t.lastReviewNotes, NOTES_CAP), 0, 0, mdTheme));
				}
			}
			if (details.stopReason) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("error", `⚠ stopped: ${details.stopReason}`), 0, 0));
				if (details.stopMessage) container.addChild(new Text(theme.fg("dim", details.stopMessage), 0, 0));
			}
			if (details.trackerFile) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", `tracker: ${details.trackerFile}`), 0, 0));
			}
			const usage = formatUsage(details.totalUsage);
			if (usage) container.addChild(new Text(theme.fg("dim", `${usage} · ${details.childRuns} child agents`), 0, 0));
			return container;
		}

		let text = header;
		for (const t of details.tasks) {
			const icon = statusIcon(t.status) === "✓" ? theme.fg("success", "✓") : statusIcon(t.status) === "✗" ? theme.fg("error", "✗") : theme.fg("muted", statusIcon(t.status));
			const bits = [t.status];
			if (t.attempts > 1) bits.push(`${t.attempts} attempts`);
			if (t.failures) bits.push(`${t.failures} failures`);
			text += `\n${icon} ${theme.fg("accent", `[${t.index}] ${t.title}`)}${theme.fg("muted", ` (${bits.join(", ")})`)}`;
		}
		if (details.stopReason) text += `\n${theme.fg("error", `⚠ ${details.stopReason} — see report`)}`;
		if (details.trackerFile) text += `\n${theme.fg("muted", `tracker: ${details.trackerFile}`)}`;
		const usage = formatUsage(details.totalUsage);
		if (usage) text += `\n${theme.fg("dim", `${usage} · ${details.childRuns} child agents`)}`;
		return new Text(text, 0, 0);
	},
};

// ---------------------------------------------------------------------------
// Tool: scout (implementer / reviewer children only)
// ---------------------------------------------------------------------------

const scoutTool = {
	name: "scout",
	label: "Scout",
	description:
		"Delegate read-only codebase investigation to a scout subagent. Returns compressed findings (files, key symbols, dependencies) without polluting your context. Use it before reading files yourself.",
	parameters: ScoutParams,

	async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
		const cwd = ctx.cwd;
		const discovery = discoverAgents(cwd, BUNDLED_AGENTS_DIR);
		const agent = discovery.agents.find((a) => a.name === "scout");
		if (!agent) {
			return {
				content: [{ type: "text", text: "Scout agent definition not found (expected a `scout` agent in an agents directory)." }],
				details: undefined,
				isError: true,
			};
		}

		const defaults: DispatchDefaults = {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: ctx.thinkingLevel,
		};

		const prompt = `Thoroughness: ${params.thoroughness ?? "medium"}\n\nInvestigation request: ${params.query}`;
		const run = await runChild({
			role: "scout",
			agent,
			prompt,
			cwd,
			defaults,
			signal,
		});

		const output = run.ok ? run.finalText || "(no findings)" : `Scout failed: ${run.errorMessage || run.stderr || "unknown error"}`;
		return {
			content: [{ type: "text", text: truncateText(output, SCOUT_OUTPUT_CAP) }],
			details: { query: params.query, ok: run.ok, usage: run.usage },
			usage: {
				input: run.usage.input,
				output: run.usage.output,
				cacheRead: run.usage.cacheRead,
				cacheWrite: run.usage.cacheWrite,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: run.usage.cost },
			},
			isError: !run.ok,
		};
	},

	renderCall(args: any, theme: any) {
		const preview = args.query.length > 60 ? `${args.query.slice(0, 60)}...` : args.query;
		return new Text(
			theme.fg("toolTitle", theme.bold("scout ")) + theme.fg("muted", `[${args.thoroughness ?? "medium"}]`) + `\n  ${theme.fg("dim", preview)}`,
			0,
			0,
		);
	},

	renderResult(result: any, _options: any, theme: any) {
		const text = result.content[0];
		return new Text(theme.fg("toolOutput", text?.type === "text" ? truncateText(text.text, 2000) : "(no output)"), 0, 0);
	},
};

// ---------------------------------------------------------------------------
// Extension entry point — role-gated registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const role = process.env[ROLE_ENV];

	if (role === "implementer" || role === "reviewer") {
		// Child agents get the scout tool for codebase recon.
		pi.registerTool(scoutTool as any);
		return;
	}

	if (role === "scout" || role === "plan-auditor") {
		// Leaf agents: nothing extra (prevents any recursion).
		return;
	}

	// Parent session: the orchestration entry point.
	pi.registerTool(orchestrateTool as any);
}
