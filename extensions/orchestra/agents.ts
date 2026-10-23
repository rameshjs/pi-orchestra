/**
 * Agent discovery for pi-orchestra.
 *
 * Agents are markdown files with frontmatter. Precedence (later wins):
 *   1. bundled  — <package>/agents (shipped defaults: implementer, reviewer, plan-auditor, scout)
 *   2. user     — ~/.pi/agent/agents
 *   3. project  — nearest .pi/agents from the working directory
 *
 * A user or project file with the same `name` overrides a bundled agent, so
 * every persona (including its model, tools, and system prompt) is customizable
 * without touching the package.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear. Only an alias picks
 * up the implicit index signature `parseFrontmatter` requires.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 * Both spellings are valid YAML: `tools: read, bash` and `tools: [read, bash]`.
 * Anything malformed yields no tools rather than throwing — one bad file must
 * not take down discovery of every other agent.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, bundledDir: string): AgentDiscoveryResult {
	const dirs: Array<[string, AgentSource]> = [
		[bundledDir, "bundled"],
		[path.join(getAgentDir(), "agents"), "user"],
	];
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	if (projectAgentsDir) dirs.push([projectAgentsDir, "project"]);

	const agentMap = new Map<string, AgentConfig>();
	for (const [dir, source] of dirs) {
		for (const agent of loadAgentsFromDir(dir, source)) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
