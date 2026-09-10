/**
 * /goal-config — interactive settings UI for myzgoal, built on SettingsList.
 *
 * Persistence: writes to the project file (<cwd>/.pi/myzgoal.json) by default
 * when the project is trusted, otherwise the global file (~/.pi/agent/myzgoal.json).
 * The "写入位置" item switches the write target at runtime (not persisted).
 */

import {
	DynamicBorder,
	getSettingsListTheme,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import {
	globalConfigPath,
	loadEffectiveConfig,
	projectConfigPath,
	writeConfig,
	type ConfigSource,
	type MyzgoalConfig,
} from "./config.js";

const MAX_TURNS_VALUES = ["unlimited", "5", "10", "20", "50", "100"];
const NO_PROGRESS_VALUES = ["1", "2", "3", "5", "10"];

const SOURCE_TAG: Record<ConfigSource, string> = {
	env: "env 变量",
	project: "项目配置",
	global: "全局配置",
	default: "默认",
};

function modelDisplay(eff: ReturnType<typeof loadEffectiveConfig>): string {
	const value = eff.evaluatorModel.value || "自动(最便宜已认证模型)";
	return `${value} · ${SOURCE_TAG[eff.evaluatorModel.source]}`;
}

function maxTurnsDisplay(eff: ReturnType<typeof loadEffectiveConfig>): string {
	const value = eff.maxTurns.value;
	return `${value === null ? "unlimited" : String(value)} · ${SOURCE_TAG[eff.maxTurns.source]}`;
}

function noProgressDisplay(eff: ReturnType<typeof loadEffectiveConfig>): string {
	return `${eff.noProgressLimit.value} · ${SOURCE_TAG[eff.noProgressLimit.source]}`;
}

/** Model picker submenu: "(auto)" plus authenticated models, cheapest first. */
function buildModelPicker(ctx: ExtensionContext, done: (selectedValue?: string) => void): Component {
	const theme: Theme = ctx.ui.theme;
	const models = ctx.modelRegistry
		.getAvailable()
		.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m))
		.sort((a, b) => a.cost.input - b.cost.input)
		.slice(0, 30);

	const items: SelectItem[] = [
		{ value: "", label: "(auto)", description: "自动选择最便宜的已认证模型" },
		...models.map((m) => ({
			value: `${m.provider}/${m.id}`,
			label: `${m.provider}/${m.id}`,
			description: `input cost ${m.cost.input}`,
		})),
	];

	const container = new Container();
	container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	container.addChild(new Text(theme.fg("accent", theme.bold("选择评估模型")), 1, 0));

	const list = new SelectList(items, Math.min(items.length, 12), {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	});
	list.onSelect = (item) => done(item.value); // "" = auto → key deleted
	list.onCancel = () => done(undefined);
	container.addChild(list);

	container.addChild(new Text(theme.fg("dim", "↑↓ 选择 · enter 确认 · esc 取消"), 1, 0));
	container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

	return {
		render: (width) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data) => {
			list.handleInput(data);
		},
	};
}

export async function openConfig(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const projectTrusted = ctx.isProjectTrusted();
	let scope: "project" | "global" = projectTrusted ? "project" : "global";
	let listRef: SettingsList | undefined;
	let currentEff = loadEffectiveConfig(ctx);

	const items: SettingItem[] = [
		{
			id: "evaluatorModel",
			label: "评估模型",
			description: "独立评估器使用的模型;auto = 最便宜的已认证模型",
			currentValue: modelDisplay(currentEff),
			submenu: (_currentValue, done) => buildModelPicker(ctx, done),
		},
		{
			id: "maxTurns",
			label: "评估次数上限",
			description: "评估满此次数后暂停循环(目标保留);unlimited = 不限制",
			currentValue: maxTurnsDisplay(currentEff),
			values: MAX_TURNS_VALUES,
		},
		{
			id: "noProgressLimit",
			label: "无进展阈值",
			description: "连续 N 回合无工具调用后暂停循环",
			currentValue: noProgressDisplay(currentEff),
			values: NO_PROGRESS_VALUES,
		},
		{
			id: "writeScope",
			label: "写入位置",
			description: projectTrusted
				? "配置写入项目文件还是全局文件(仅影响本次保存)"
				: "项目未受信,仅可写入全局配置",
			currentValue: scope === "project" ? "project" : "global",
			values: projectTrusted ? ["project", "global"] : ["global"],
		},
	];

	const onChange = (id: string, newValue: string) => {
		if (id === "writeScope") {
			scope = newValue === "global" ? "global" : "project";
			return;
		}

		let patch: Partial<MyzgoalConfig>;
		if (id === "evaluatorModel") {
			// "" = auto → delete the key so resolution falls through to cheaper sources.
			patch = { evaluatorModel: newValue === "" ? undefined : newValue };
		} else if (id === "maxTurns") {
			patch = { maxTurns: newValue === "unlimited" ? null : Number.parseInt(newValue, 10) };
		} else if (id === "noProgressLimit") {
			patch = { noProgressLimit: Number.parseInt(newValue, 10) };
		} else {
			return;
		}

		try {
			const path = writeConfig(ctx, scope, patch);
			// Refresh source tags after the write, then push the new display strings.
			currentEff = loadEffectiveConfig(ctx);
			const displays: Record<string, string> = {
				evaluatorModel: modelDisplay(currentEff),
				maxTurns: maxTurnsDisplay(currentEff),
				noProgressLimit: noProgressDisplay(currentEff),
			};
			for (const [itemId, display] of Object.entries(displays)) {
				if (itemId !== "writeScope") listRef?.updateValue(itemId, display);
			}
			if (ctx.hasUI) ctx.ui.notify(`已保存到 ${path}`, "info");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) ctx.ui.notify(`保存失败: ${message}`, "error");
		}
	};

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("myzgoal 设置")), 1, 0));

		const settingsList = new SettingsList(items, items.length + 2, getSettingsListTheme(), onChange, () =>
			done(undefined),
		);
		listRef = settingsList;
		container.addChild(settingsList);

		container.addChild(new Text(theme.fg("dim", `project: ${projectConfigPath(ctx.cwd)}`), 1, 0));
		container.addChild(new Text(theme.fg("dim", `global:   ${globalConfigPath()}`), 1, 0));
		container.addChild(new Text(theme.fg("dim", "↑↓/jk 移动 · enter/space 修改 · esc 关闭"), 1, 0));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				settingsList.handleInput(data);
			},
		};
	});
}
