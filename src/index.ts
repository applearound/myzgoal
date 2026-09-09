/**
 * myzgoal — /goal for PI Agent.
 *
 * Set a completion condition with /goal and pi keeps working across turns
 * until a separate evaluator model confirms the condition is met, judges it
 * impossible, or an unrecoverable state pauses the loop. Mirrors Claude
 * Code's /goal semantics: the model doing the work no longer decides when
 * the work is done.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluateGoal, pickEvaluatorModel } from "./evaluator.js";
import {
	ENTRY_ACHIEVED,
	ENTRY_CLEARED,
	ENTRY_FAILED,
	ENTRY_SET,
	ENTRY_VERDICT,
	registerRenderers,
	widgetLines,
	WIDGET_ID,
} from "./render.js";
import {
	createGoal,
	formatCost,
	formatDuration,
	MAX_CONDITION_LENGTH,
	truncate,
	type GoalState,
	type ResolvedGoalRecord,
} from "./state.js";

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
const DEFAULT_NO_PROGRESS_LIMIT = 3;

type BranchEntry = {
	type?: string;
	customType?: string;
	data?: Record<string, unknown>;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
	};
};

type ContentPart = {
	type?: string;
	name?: string;
};

function noProgressLimit(): number {
	const parsed = Number.parseInt(process.env.MYZGOAL_NO_PROGRESS_LIMIT ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NO_PROGRESS_LIMIT;
}

function maxTurns(): number | null {
	const parsed = Number.parseInt(process.env.MYZGOAL_MAX_TURNS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Whether the most recent agent run (entries after the last user message) used any tools. */
function lastRunHadToolUse(branch: readonly BranchEntry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		if (role === "user") break;
		if (role === "toolResult") return true;
		if (role === "assistant" && Array.isArray(content) && (content as ContentPart[]).some((p) => p?.type === "toolCall")) {
			return true;
		}
	}
	return false;
}

/** Validate persisted resolved-goal entry data (entries come from the session file, shape is untrusted). */
function parseResolvedGoalRecord(data: Record<string, unknown>): ResolvedGoalRecord | null {
	if (typeof data.condition !== "string" || typeof data.setAt !== "number" || typeof data.resolvedAt !== "number") {
		return null;
	}
	return {
		condition: data.condition,
		setAt: data.setAt,
		resolvedAt: data.resolvedAt,
		turnsEvaluated: typeof data.turnsEvaluated === "number" ? data.turnsEvaluated : 0,
		tokensSpent: typeof data.tokensSpent === "number" ? data.tokensSpent : 0,
		reason: typeof data.reason === "string" ? data.reason : undefined,
	};
}

/** Whether the most recent assistant message was aborted (user pressed Esc). */
function lastAssistantAborted(branch: readonly BranchEntry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			return entry.message.stopReason === "aborted";
		}
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	let goal: GoalState | null = null;
	let lastResolved: ResolvedGoalRecord | null = null;
	let evaluating = false;
	let noProgressTurns = 0;

	const updateWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget(WIDGET_ID, goal ? widgetLines(goal) : []);
		} catch {
			// Widget is best-effort; some modes may not support it.
		}
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	const resolveGoal = (
		ctx: ExtensionContext,
		outcome: "achieved" | "failed",
		reason: string,
	): void => {
		if (!goal) return;
		const record: ResolvedGoalRecord = {
			condition: goal.condition,
			setAt: goal.setAt,
			resolvedAt: Date.now(),
			turnsEvaluated: goal.turnsEvaluated,
			tokensSpent: goal.tokensSpent,
			reason,
		};
		pi.appendEntry(outcome === "achieved" ? ENTRY_ACHIEVED : ENTRY_FAILED, record);
		lastResolved = record;
		goal = null;
		updateWidget(ctx);
		if (outcome === "achieved") {
			notify(
				ctx,
				`✓ Goal achieved: ${truncate(record.condition, 120)} · ${record.turnsEvaluated} turns · ${formatDuration(record.setAt, record.resolvedAt)} · ${formatCost(record.tokensSpent)} evaluator spend`,
			);
		} else {
			notify(ctx, `✗ Goal judged impossible: ${reason}`, "warning");
		}
	};

	registerRenderers(pi);

	// Restore goal state on session start (covers /resume and /reload).
	pi.on("session_start", async (_event, ctx) => {
		let restoredGoal: GoalState | null = null;
		let restoredResolved: ResolvedGoalRecord | null = null;

		for (const raw of ctx.sessionManager.getEntries()) {
			const entry = raw as BranchEntry;
			if (entry.type !== "custom" || !entry.customType) continue;
			const data = (entry.data ?? {}) as Record<string, unknown>;
			switch (entry.customType) {
				case ENTRY_SET:
					if (typeof data.condition === "string") {
						// Per Claude Code semantics: carry over the condition,
						// reset turn count / timer / token-spend baseline.
						restoredGoal = createGoal(data.condition);
						restoredResolved = null;
					}
					break;
				case ENTRY_ACHIEVED:
				case ENTRY_FAILED: {
					const record = parseResolvedGoalRecord(data);
					if (record) {
						restoredResolved = record;
						restoredGoal = null;
					}
					break;
				}
				case ENTRY_CLEARED:
					restoredGoal = null;
					break;
				default:
					break;
			}
		}

		goal = restoredGoal;
		lastResolved = restoredResolved;
		noProgressTurns = 0;
		evaluating = false;
		updateWidget(ctx);
	});

	// Unpause the loop when the user sends a new prompt.
	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		if (goal?.loopPaused) {
			goal.loopPaused = false;
			noProgressTurns = 0;
		}
		return { action: "continue" };
	});

	// Evaluate after every settled run: verdict decides whether to continue.
	// SAFETY: pi may emit agent_settled with a stale ctx after session teardown
	// (observed in print mode); probe ctx liveness first and bail out silently.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!goal || goal.loopPaused || evaluating) return;
		try {
			ctx.sessionManager.getBranch();
		} catch {
			return; // stale ctx after session replacement/reload — nothing to do
		}

		const branch = ctx.sessionManager.getBranch() as BranchEntry[];
		if (lastAssistantAborted(branch)) return; // user interrupted; do not fight them

		// No-progress guard: agent keeps answering without doing anything.
		if (lastRunHadToolUse(branch)) {
			noProgressTurns = 0;
		} else {
			noProgressTurns++;
			if (noProgressTurns >= noProgressLimit()) {
				goal.loopPaused = true;
				updateWidget(ctx);
				notify(
					ctx,
					`◎ /goal loop paused: ${noProgressTurns} consecutive turns without tool use. The goal stays active — send a prompt to resume evaluation.`,
					"warning",
				);
				return;
			}
		}

		// Optional hard turn cap.
		const cap = maxTurns();
		if (cap !== null && goal.turnsEvaluated >= cap) {
			goal.loopPaused = true;
			updateWidget(ctx);
			notify(ctx, `◎ /goal loop paused: reached MYZGOAL_MAX_TURNS=${cap}. The goal stays active — send a prompt to resume.`, "warning");
			return;
		}

		evaluating = true;
		try {
			const picked = pickEvaluatorModel(ctx);
			if ("error" in picked) {
				goal.loopPaused = true;
				updateWidget(ctx);
				notify(ctx, `◎ /goal loop paused: ${picked.error}. The goal stays active — fix the issue and send a prompt to resume.`, "warning");
				return;
			}

			const result = await evaluateGoal(goal, picked.model, ctx);
			goal.turnsEvaluated++;
			if (result.usage) goal.tokensSpent += result.usage.cost.total;
			goal.lastReason = result.reason;

			if (result.verdict === "not_yet") {
				pi.appendEntry(ENTRY_VERDICT, { verdict: result.verdict, reason: result.reason, turn: goal.turnsEvaluated });
				updateWidget(ctx);
				pi.sendUserMessage(
					`Your /goal is not yet met: "${goal.condition}"\n\n` +
						`Evaluator feedback: ${result.reason}\n\n` +
						`Continue working toward the goal. When you believe it is met, demonstrate it (run the checks, show the output) so the result is visible in the conversation for the evaluator.`,
					{ deliverAs: "followUp" },
				);
			} else if (result.verdict === "met") {
				resolveGoal(ctx, "achieved", result.reason);
			} else {
				resolveGoal(ctx, "failed", result.reason);
			}
		} catch (err) {
			goal.loopPaused = true;
			updateWidget(ctx);
			const message = err instanceof Error ? err.message : String(err);
			notify(ctx, `◎ /goal loop paused: evaluator error — ${message}. The goal stays active — send a prompt to resume.`, "error");
		} finally {
			evaluating = false;
		}
	});

	pi.registerCommand("goal", {
		description: "Set a goal: pi keeps working across turns until the condition is met (/goal <condition>, /goal for status, /goal clear to remove)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			// Status
			if (!arg) {
				if (goal) {
					const lines = [
						`◎ /goal active: ${goal.condition}`,
						`Running for ${formatDuration(goal.setAt)} · ${goal.turnsEvaluated} turns evaluated · ${formatCost(goal.tokensSpent)} evaluator spend`,
					];
					if (goal.loopPaused) lines.push("Loop paused — send a prompt to resume evaluation.");
					if (goal.lastReason) lines.push(`Latest evaluator reason: ${goal.lastReason}`);
					notify(ctx, lines.join("\n"));
				} else if (lastResolved) {
					notify(
						ctx,
						`No goal active. Last resolved goal: ${lastResolved.condition} · ${lastResolved.turnsEvaluated} turns · ${formatCost(lastResolved.tokensSpent)}`,
					);
				} else {
					notify(ctx, "No goal set. Usage: /goal <condition> — e.g. /goal all tests pass and lint is clean");
				}
				return;
			}

			// Clear
			if (CLEAR_ALIASES.has(arg.toLowerCase())) {
				if (goal) {
					pi.appendEntry(ENTRY_CLEARED, { condition: goal.condition, by: "user" });
					notify(ctx, `Goal cleared: ${truncate(goal.condition, 120)}`);
					goal = null;
					updateWidget(ctx);
				} else {
					notify(ctx, "No goal set.");
				}
				return;
			}

			// Set (replaces any active goal)
			if (arg.length > MAX_CONDITION_LENGTH) {
				notify(ctx, `Condition too long: ${arg.length} chars (max ${MAX_CONDITION_LENGTH}).`, "error");
				return;
			}
			goal = createGoal(arg);
			noProgressTurns = 0;
			evaluating = false;
			pi.appendEntry(ENTRY_SET, { condition: arg, setAt: goal.setAt });
			updateWidget(ctx);
			// Start a turn immediately, with the condition itself as the directive.
			pi.sendUserMessage(arg, goal ? { deliverAs: "followUp" } : undefined);
		},
	});
}
