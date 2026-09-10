/**
 * Config file layer for myzgoal.
 *
 * Persistence locations (pi conventions):
 * - global:  <agentDir>/myzgoal.json   (usually ~/.pi/agent/myzgoal.json)
 * - project: <cwd>/.pi/myzgoal.json    (only honored when the project is trusted)
 *
 * Per-setting precedence: env var > project file > global file > built-in default.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ConfigSource = "env" | "project" | "global" | "default";

export interface MyzgoalConfig {
	/** "provider/model-id". Empty/undefined = auto (cheapest authenticated model). */
	evaluatorModel?: string;
	/** Evaluator-run cap. null = explicit unlimited; undefined = not set (falls through). */
	maxTurns?: number | null;
	/** Consecutive tool-less turns before the loop pauses. */
	noProgressLimit?: number;
}

export interface LoadedConfigFile {
	path: string;
	/** Validated known fields. */
	config: MyzgoalConfig;
	/** Full parsed object — unknown keys are preserved for lossless writes. */
	raw: Record<string, unknown>;
}

export interface EffectiveConfig {
	project?: LoadedConfigFile;
	global?: LoadedConfigFile;
	evaluatorModel: { value?: string; source: ConfigSource };
	maxTurns: { value: number | null; source: ConfigSource };
	noProgressLimit: { value: number; source: ConfigSource };
}

export const DEFAULT_NO_PROGRESS_LIMIT = 3;

export function globalConfigPath(): string {
	return join(getAgentDir(), "myzgoal.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "myzgoal.json");
}

/** Lenient parse: malformed values are dropped, malformed files behave as absent. */
function parseConfigFile(path: string): LoadedConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const config: MyzgoalConfig = {};
		if (typeof raw.evaluatorModel === "string") config.evaluatorModel = raw.evaluatorModel;
		if (raw.maxTurns === null) {
			config.maxTurns = null; // explicit unlimited
		} else if (typeof raw.maxTurns === "number" && Number.isFinite(raw.maxTurns) && raw.maxTurns > 0) {
			config.maxTurns = Math.floor(raw.maxTurns);
		}
		if (typeof raw.noProgressLimit === "number" && Number.isFinite(raw.noProgressLimit) && raw.noProgressLimit > 0) {
			config.noProgressLimit = Math.floor(raw.noProgressLimit);
		}
		return { path, config, raw };
	} catch {
		return undefined;
	}
}

function envInt(name: string): number | undefined {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function resolveSetting<T>(
	env: T | undefined,
	project: T | undefined,
	global: T | undefined,
	fallback: T,
): { value: T; source: ConfigSource } {
	if (env !== undefined) return { value: env, source: "env" };
	if (project !== undefined) return { value: project, source: "project" };
	if (global !== undefined) return { value: global, source: "global" };
	return { value: fallback, source: "default" };
}

export function loadEffectiveConfig(ctx: ExtensionContext): EffectiveConfig {
	const global = parseConfigFile(globalConfigPath());
	const project = ctx.isProjectTrusted() ? parseConfigFile(projectConfigPath(ctx.cwd)) : undefined;

	return {
		project,
		global,
		evaluatorModel: resolveSetting(
			process.env.MYZGOAL_EVALUATOR_MODEL || undefined,
			project?.config.evaluatorModel || undefined,
			global?.config.evaluatorModel || undefined,
			undefined,
		),
		maxTurns: resolveSetting(
			envInt("MYZGOAL_MAX_TURNS"),
			project?.config.maxTurns ?? undefined,
			global?.config.maxTurns ?? undefined,
			null,
		),
		noProgressLimit: resolveSetting(
			envInt("MYZGOAL_NO_PROGRESS_LIMIT"),
			project?.config.noProgressLimit,
			global?.config.noProgressLimit,
			DEFAULT_NO_PROGRESS_LIMIT,
		),
	};
}

/** Merge `patch` into the target file, preserving unknown keys. Empty-string values delete the key. */
export function writeConfig(
	ctx: ExtensionContext,
	scope: "project" | "global",
	patch: Partial<MyzgoalConfig>,
): string {
	const path = scope === "project" ? projectConfigPath(ctx.cwd) : globalConfigPath();
	const raw: Record<string, unknown> = { ...parseConfigFile(path)?.raw };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined || value === "") delete raw[key];
		else raw[key] = value;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	return path;
}
