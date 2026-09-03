import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { selectTextOnTripleClick } from "./text-selection";

afterEach(() => {
	document.body.replaceChildren();
	document.getSelection()?.removeAllRanges();
	vi.restoreAllMocks();
});

function mouseEvent(
	target: HTMLElement,
	options: { button?: number; detail: number },
): ReactMouseEvent<HTMLElement> {
	return {
		button: options.button ?? 0,
		detail: options.detail,
		currentTarget: target,
		preventDefault: vi.fn(),
	} as unknown as ReactMouseEvent<HTMLElement>;
}

describe("selectTextOnTripleClick", () => {
	test("leaves native selection unchanged before a primary-button triple-click", () => {
		const target = document.createElement("span");
		target.textContent = "Folder Path/with spaces";
		document.body.append(target);

		const doubleClick = mouseEvent(target, { detail: 2 });
		selectTextOnTripleClick(doubleClick);
		expect(doubleClick.preventDefault).not.toHaveBeenCalled();

		const rightClick = mouseEvent(target, { button: 2, detail: 3 });
		selectTextOnTripleClick(rightClick);
		expect(rightClick.preventDefault).not.toHaveBeenCalled();
	});

	test.each([3, 4])("selects only the target text at click detail %i", (detail) => {
		const target = document.createElement("span");
		target.textContent = "Folder Path/with spaces";
		document.body.append("before ", target, " after");
		const event = mouseEvent(target, { detail });

		selectTextOnTripleClick(event);

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(document.getSelection()?.toString()).toBe("Folder Path/with spaces");
	});

	test("preserves native behavior when selection is unavailable", () => {
		const target = document.createElement("span");
		const event = mouseEvent(target, { detail: 3 });
		vi.spyOn(document, "getSelection").mockReturnValue(null);

		selectTextOnTripleClick(event);

		expect(event.preventDefault).not.toHaveBeenCalled();
	});
});
