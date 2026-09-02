import type { MouseEvent } from "react";

export function selectTextOnTripleClick(event: MouseEvent<HTMLElement>): void {
	if (event.button !== 0 || event.detail < 3) return;
	const document = event.currentTarget.ownerDocument;
	const selection = document.getSelection();
	if (selection === null) return;
	event.preventDefault();
	const range = document.createRange();
	range.selectNodeContents(event.currentTarget);
	selection.removeAllRanges();
	selection.addRange(range);
}
