/**
 * TUI rendering — entry renderers for goal lifecycle entries and widget text.
 */

import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { formatCost, formatDuration, truncate, type GoalState, type ResolvedGoalRecord } from "./state.js";

// Entry customTypes (also used for state reconstruction on session_start).
export const ENTRY_SET = "myzgoal:set";
export const ENTRY_VERDICT = "myzgoal:verdict";
export const ENTRY_ACHIEVED = "myzgoal:achieved";
export const ENTRY_FAILED = "myzgoal:failed";
export const ENTRY_CLEARED = "myzgoal:cleared";

export const WIDGET_ID = "myzgoal";

function goalBox(lines: string[], theme: Theme): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	for (const line of lines) box.addChild(new Text(line, 0, 0));
	return box;
}

function dim(theme: Theme, text: string): string {
	return theme.fg("dim", text);
}

export function registerRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(ENTRY_SET, (entry, _opts, theme) => {
		const data = (entry.data ?? {}) as { condition?: string };
		return goalBox(
			[
				`◎ Goal set: ${truncate(data.condition ?? "", 200)}`,
				dim(theme, "pi keeps working until a separate evaluator confirms the condition is met."),
			],
			theme,
		);
	});

	pi.registerEntryRenderer(ENTRY_VERDICT, (entry, _opts, theme) => {
		const data = (entry.data ?? {}) as { verdict?: string; reason?: string; turn?: number };
		const icon = data.verdict === "not_yet" ? "↻" : data.verdict === "met" ? "✓" : "✗";
		return goalBox(
			[`${icon} Evaluator: ${data.verdict ?? "?"} (turn ${data.turn ?? "?"})`, dim(theme, truncate(data.reason ?? "", 300))],
			theme,
		);
	});

	pi.registerEntryRenderer(ENTRY_ACHIEVED, (entry, _opts, theme) => {
		const data = (entry.data ?? {}) as Partial<ResolvedGoalRecord>;
		const duration = data.setAt && data.resolvedAt ? formatDuration(data.setAt, data.resolvedAt) : "?";
		return goalBox(
			[
				`✓ Goal achieved: ${truncate(data.condition ?? "", 200)}`,
				dim(theme, `${duration} · ${data.turnsEvaluated ?? 0} turns evaluated · ${formatCost(data.tokensSpent ?? 0)} evaluator spend`),
				dim(theme, truncate(data.reason ?? "", 300)),
			],
			theme,
		);
	});

	pi.registerEntryRenderer(ENTRY_FAILED, (entry, _opts, theme) => {
		const data = (entry.data ?? {}) as Partial<ResolvedGoalRecord>;
		const duration = data.setAt && data.resolvedAt ? formatDuration(data.setAt, data.resolvedAt) : "?";
		return goalBox(
			[
				`✗ Goal judged impossible: ${truncate(data.condition ?? "", 200)}`,
				dim(theme, `${duration} · ${data.turnsEvaluated ?? 0} turns evaluated · ${formatCost(data.tokensSpent ?? 0)} evaluator spend`),
				dim(theme, truncate(data.reason ?? "", 300)),
			],
			theme,
		);
	});

	pi.registerEntryRenderer(ENTRY_CLEARED, (entry, _opts, theme) => {
		const data = (entry.data ?? {}) as { condition?: string; by?: string };
		return goalBox([`◌ Goal cleared: ${truncate(data.condition ?? "", 200)}${data.by ? ` (${data.by})` : ""}`], theme);
	});
}

export function widgetLines(goal: GoalState): string[] {
	const bits: string[] = [formatDuration(goal.setAt)];
	if (goal.turnsEvaluated > 0) bits.push(`${goal.turnsEvaluated} turns`);
	bits.push(formatCost(goal.tokensSpent));
	if (goal.loopPaused) bits.push("paused");
	const lines = [`◎ /goal active · ${bits.join(" · ")}`];
	if (goal.lastReason) lines.push(truncate(goal.lastReason, 100));
	return lines;
}
