/**
 * Goal state — in-memory representation plus (de)serialization helpers for
 * session persistence via `pi.appendEntry()`.
 */

export interface GoalState {
	/** Completion condition text (≤4000 chars). */
	condition: string;
	/** Epoch ms when the goal was set. */
	setAt: number;
	/** Number of evaluator runs completed. */
	turnsEvaluated: number;
	/** Cumulative evaluator token spend (USD, from usage cost). */
	tokensSpent: number;
	/** Evaluator's most recent reason. */
	lastReason?: string;
	/** Whether the auto-continue loop is currently paused (no-progress guard / evaluator error). */
	loopPaused: boolean;
}

export interface ResolvedGoalRecord {
	condition: string;
	setAt: number;
	resolvedAt: number;
	turnsEvaluated: number;
	tokensSpent: number;
	/** For "failed": why the evaluator judged the condition impossible. */
	reason?: string;
}

export const MAX_CONDITION_LENGTH = 4000;

export function createGoal(condition: string): GoalState {
	return {
		condition,
		setAt: Date.now(),
		turnsEvaluated: 0,
		tokensSpent: 0,
		loopPaused: false,
	};
}

export function formatDuration(fromMs: number, toMs: number = Date.now()): string {
	const totalSec = Math.max(0, Math.round((toMs - fromMs) / 1000));
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min === 0) return `${sec}s`;
	if (min < 60) return `${min}m ${sec}s`;
	const h = Math.floor(min / 60);
	return `${h}h ${min % 60}m`;
}

export function formatCost(usd: number): string {
	if (usd === 0) return "$0";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}
