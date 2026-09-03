import { expect, test } from "bun:test";
import { ProcessOutputLineBuffer } from "./process-output";

test("removes ANSI sequences that cross input and output boundaries", () => {
	const lines: string[] = [];
	const output = new ProcessOutputLineBuffer((line) => lines.push(line));

	output.write(`${"a".repeat(3_999)}\u001b[31`);
	output.write("mred\u001b[0");
	output.write("m\n");

	expect(lines).toEqual([`${"a".repeat(3_999)}r`, "ed"]);
});

test("drops an incomplete ANSI sequence when output closes", () => {
	const lines: string[] = [];
	const output = new ProcessOutputLineBuffer((line) => lines.push(line));

	output.write("Visible\u001b[31");
	output.flush();

	expect(lines).toEqual(["Visible"]);
});

test("removes control strings and general escape sequences across input boundaries", () => {
	const lines: string[] = [];
	const output = new ProcessOutputLineBuffer((line) => lines.push(line));

	output.write("before\u001b]0;Worker title");
	output.write("\u0007middle\u001b7after\u001b]8;;https://example.com\u001b");
	output.write("\\link\n");

	expect(lines).toEqual(["beforemiddleafterlink"]);
});

test("keeps Unicode code points intact across output boundaries", () => {
	const lines: string[] = [];
	const output = new ProcessOutputLineBuffer((line) => lines.push(line));

	output.write(`${"a".repeat(3_999)}😀tail\n`);

	expect(lines).toEqual(["a".repeat(3_999), "😀tail"]);
});

test("keeps Unicode code points intact across input boundaries", () => {
	const lines: string[] = [];
	const output = new ProcessOutputLineBuffer((line) => lines.push(line));

	output.write(`${"a".repeat(3_999)}\ud83d`);
	output.write("\ude00\n");

	expect(lines).toEqual(["a".repeat(3_999), "😀"]);
});

test("preserves whitespace at artificial output boundaries", () => {
	const lines: string[] = [];
	const output = new ProcessOutputLineBuffer((line) => lines.push(line));

	output.write(`${"x".repeat(3_999)} y`);
	output.flush();

	expect(lines).toEqual([`${"x".repeat(3_999)} `, "y"]);
});
