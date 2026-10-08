/**
 * How the recall at session start looks in the transcript. The model always receives the full
 * list; this only decides what the person sees.
 *
 * Two looks, chosen each time the row is drawn:
 *  - with pi-halo loaded: one plain row drawn like its tool rows (a dim brain icon, the title,
 *    the count on the right), expanding to the list underneath. halo leaves this type's own
 *    drawing alone (it lists "memory-recall" among the messages that draw a plain row).
 *  - without it: pi's standard boxed custom message, "[memory-recall] N memories recalled" with an
 *    expand hint.
 *
 * pi-recall does not depend on halo: see halo.ts for how it finds it.
 */

import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MEMORY_ICON } from "./halo.ts";

export const RECALL_ICON = MEMORY_ICON.nerd;

type Details = { count?: number; total?: number; chars?: number };
type Message = Parameters<MessageRenderer<Details>>[0];
type Options = Parameters<MessageRenderer<Details>>[1];

export interface RecallDeps {
	/** The "ctrl+o to expand" hint, as pi words it for the current keybindings. */
	expandHint: () => string;
	/** Whether pi-halo is loaded. */
	halo: () => boolean;
}

const noun = (n: number) => `${n} ${n === 1 ? "memory" : "memories"}`;

/** "12 memories", or "12 of 31 memories" when some were left out. */
function countText(d: Details | undefined): string {
	const count = d?.count ?? 0;
	const total = d?.total;
	return total !== undefined && total > count ? `${count} of ${noun(total)}` : noun(count);
}

function bodyOf(message: Message): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("\n");
}

/** The halo look: one plain row, the list under it when expanded. */
export function plainRecallRow(message: Message, options: Options, theme: Theme): Component {
	const left = `${theme.fg("dim", RECALL_ICON)} ${theme.fg("text", "Recall")} ${theme.fg("muted", "session memories")}`;
	const right = theme.fg("dim", countText(message.details));
	const body = options.expanded ? bodyOf(message).replace(/\s+$/, "") : "";
	return {
		invalidate() {},
		render(width: number): string[] {
			const w = Math.max(1, width - 2);
			const rw = visibleWidth(right);
			let line: string;
			if (rw + 4 < w) {
				const l = truncateToWidth(left, w - rw - 2, "…");
				line = `${l}${" ".repeat(Math.max(2, w - visibleWidth(l) - rw))}${right}`;
			} else {
				line = truncateToWidth(left, w, "…");
			}
			// pi puts one blank row above a custom message already, so none here.
			const lines = [` ${line}`];
			if (body) lines.push(...new Text(theme.fg("toolOutput", body), 3, 0).render(width));
			return lines;
		},
	};
}

/** pi's standard custom-message box. */
export function boxRecallRow(message: Message, options: Options, theme: Theme, hint: string): Component {
	const label = theme.fg("customMessageLabel", theme.bold("[memory-recall]"));
	let text = `${label} ${theme.fg("customMessageText", `${countText(message.details)} recalled`)}`;
	if (options.expanded) text += `\n\n${theme.fg("customMessageText", bodyOf(message))}`;
	else text += ` ${hint}`;
	const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(text, 0, 0));
	return box;
}

export function recallRenderer(deps: RecallDeps): MessageRenderer<Details> {
	return (message, options, theme) => (deps.halo() ? plainRecallRow(message, options, theme) : boxRecallRow(message, options, theme, deps.expandHint()));
}
