/**
 * Evaluator — a small fast model judges, from the conversation alone, whether
 * the goal condition holds. Mirrors Claude Code's /goal semantics:
 * the model doing the work no longer decides when the work is done.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import { loadEffectiveConfig } from "./config.js";

export type Verdict = "met" | "not_yet" | "impossible";

export interface EvaluationResult {
	verdict: Verdict;
	reason: string;
	usage?: Usage;
}

const EVALUATOR_SYSTEM_PROMPT = `You are a strict, skeptical completion evaluator for an autonomous coding agent.

You will be given a GOAL CONDITION and a transcript of the agent's conversation. Judge ONLY from what the transcript demonstrates. You cannot run commands or read files; evidence must appear in the transcript itself (command outputs, test results, tool results, file contents the agent surfaced).

Return exactly one verdict:
- "met": the transcript clearly demonstrates the condition is satisfied. Be strict: an unverified claim ("should work now", "done") without evidence does NOT count.
- "not_yet": the condition is plausible but not yet demonstrated, or work remains.
- "impossible": the condition can never be satisfied as stated (missing prerequisites, contradictory requirements, required resources do not exist, the agent is blocked in a way only the user can resolve). Use sparingly — uncertainty is "not_yet", not "impossible".

Respond with JSON only, no markdown fences, no extra text:
{"verdict": "met" | "not_yet" | "impossible", "reason": "<one or two sentences; for not_yet, concrete guidance on what to do next>"}`;

const TRANSCRIPT_BYTE_BUDGET = 48_000;
const EVALUATOR_TIMEOUT_MS = 120_000;

type BranchEntry = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
	};
};

type ContentPart = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content as ContentPart[]) {
		if (
			part &&
			typeof part === "object" &&
			part.type === "text" &&
			typeof part.text === "string"
		) {
			parts.push(part.text);
		}
	}
	return parts.join("\n");
}

function buildTranscript(branch: readonly BranchEntry[]): string {
	const lines: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		if (role === "user") {
			const text = extractText(content);
			if (text.trim()) lines.push(`[user] ${text}`);
		} else if (role === "assistant") {
			const text = extractText(content);
			if (text.trim()) lines.push(`[assistant] ${text}`);
			if (Array.isArray(content)) {
				for (const part of content as ContentPart[]) {
					if (part?.type === "toolCall" && part.name) {
						lines.push(
							`[assistant tool call] ${part.name}(${JSON.stringify(part.arguments ?? {})})`,
						);
					}
				}
			}
		} else if (role === "toolResult") {
			const text = extractText(content);
			if (text.trim()) lines.push(`[tool result] ${text}`);
		}
	}

	// Keep the tail of the transcript within budget — most recent evidence matters most.
	let total = 0;
	const kept: string[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (total + size > TRANSCRIPT_BYTE_BUDGET && kept.length > 0) {
			kept.unshift(
				`[... transcript truncated, showing the most recent ${kept.length} of ${lines.length} messages ...]`,
			);
			break;
		}
		total += size;
		kept.unshift(line);
	}
	return kept.join("\n\n");
}

/**
 * Pick the evaluator model: explicit setting (MYZGOAL_EVALUATOR_MODEL env or
 * evaluatorModel in project/global config, "provider/model-id"), otherwise the
 * cheapest authenticated model, otherwise the session's current model.
 */
export function pickEvaluatorModel(
	ctx: ExtensionContext,
): { model: Model<Api>; source: string } | { error: string } {
	const registry = ctx.modelRegistry;

	const effective = loadEffectiveConfig(ctx);
	const configured = effective.evaluatorModel.value;
	if (configured) {
		const label =
			effective.evaluatorModel.source === "env"
				? "MYZGOAL_EVALUATOR_MODEL"
				: `evaluatorModel (${effective.evaluatorModel.source})`;
		const [provider, ...rest] = configured.split("/");
		const modelId = rest.join("/");
		const model = registry.find(provider, modelId);
		if (!model) return { error: `${label} "${configured}" not found` };
		if (!registry.hasConfiguredAuth(model)) {
			return { error: `No authentication configured for "${configured}" (${label})` };
		}
		return { model, source: label };
	}

	const available = registry
		.getAvailable()
		.filter((m) => registry.hasConfiguredAuth(m));
	if (available.length === 0) {
		if (ctx.model && registry.hasConfiguredAuth(ctx.model)) {
			return {
				model: ctx.model,
				source: "session model (no alternatives available)",
			};
		}
		return { error: "No authenticated model available for evaluation" };
	}
	const cheapest = [...available].sort((a, b) => a.cost.input - b.cost.input)[0];
	if (process.env.MYZGOAL_DEBUG) {
		process.stderr.write(
			`[myzgoal] evaluator model: ${cheapest.provider}/${cheapest.id} (cheapest of ${available.length} authenticated)\n`,
		);
	}
	return { model: cheapest, source: "cheapest authenticated model" };
}

/**
 * Some hosted providers (e.g. opencode) require a session attribution header
 * on every request. Nested complete() calls do not get pi's automatic
 * attribution headers, so mirror pi's own rule (provider id or host) here.
 */
function attributionHeaders(
	model: Model<Api>,
	sessionId: string,
): Record<string, string> | undefined {
	let isOpencode =
		model.provider === "opencode" || model.provider === "opencode-go";
	if (!isOpencode) {
		try {
			isOpencode = new URL(model.baseUrl).hostname === "opencode.ai";
		} catch {
			// malformed baseUrl — treat as non-opencode
		}
	}
	return isOpencode ? { "x-opencode-session": sessionId } : undefined;
}

function parseVerdict(
	text: string,
): { verdict: Verdict; reason: string } | { error: string } {
	// Strip code fences if the model added them anyway.
	const cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end <= start)
		return { error: `Evaluator returned non-JSON output: ${text.slice(0, 200)}` };

	try {
		const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
			verdict?: string;
			reason?: string;
		};
		const verdict = parsed.verdict;
		if (verdict !== "met" && verdict !== "not_yet" && verdict !== "impossible") {
			return { error: `Unknown verdict "${verdict}"` };
		}
		const reason =
			typeof parsed.reason === "string" && parsed.reason.trim()
				? parsed.reason.trim()
				: "(no reason given)";
		return { verdict, reason };
	} catch (err) {
		return {
			error: `Failed to parse evaluator output: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export async function evaluateGoal(
	goal: { condition: string },
	model: Model<Api>,
	ctx: ExtensionContext,
): Promise<EvaluationResult> {
	const transcript = buildTranscript(
		ctx.sessionManager.getBranch() as BranchEntry[],
	);
	const userPrompt = [
		`GOAL CONDITION:\n${goal.condition}`,
		`CONVERSATION TRANSCRIPT (most recent last):\n${transcript || "(empty)"}`,
	].join("\n\n---\n\n");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EVALUATOR_TIMEOUT_MS);
	// Reuse the session's own id so provider-side attribution/caching matches
	// the surrounding conversation, and add provider-required headers.
	const sessionId = ctx.sessionManager.getSessionId?.() ?? randomUUID();
	try {
		const response: AssistantMessage = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: EVALUATOR_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: 1024,
				cacheRetention: "none" as const,
				sessionId,
				headers: attributionHeaders(model, sessionId),
			} as Parameters<typeof ctx.modelRegistry.complete>[2],
		);

		if (response.stopReason === "aborted") {
			throw new Error("Evaluation aborted");
		}
		if (response.stopReason === "error") {
			const errText = extractText(response.content);
			throw new Error(
				`Evaluator model returned an error${errText ? `: ${errText}` : " (no detail)"}`,
			);
		}

		const text = extractText(response.content);
		const parsed = parseVerdict(text);
		if ("error" in parsed) throw new Error(parsed.error);
		return {
			verdict: parsed.verdict,
			reason: parsed.reason,
			usage: response.usage,
		};
	} finally {
		clearTimeout(timer);
	}
}
