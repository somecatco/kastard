import { expect, test } from "bun:test";
import {
	collectWorkflowInputStringLeaves,
	rewriteWorkflowInputStringLeaves,
} from "./workflow-input-json";

const from = "frame.png";
const to = "kastard/job/frame.png";

const nested = JSON.stringify({
	nested: JSON.stringify({ "frame.png": 0, ref: from }),
});
const rewrittenNested = JSON.stringify({
	nested: JSON.stringify({ "frame.png": 0, ref: to }),
});

for (const scenario of [
	{ name: "plain strings", value: from, expected: to, matches: 1 },
	{
		name: "object values but not keys",
		value: { "frame.png": 0, ref: from },
		expected: { "frame.png": 0, ref: to },
		matches: 1,
	},
	{
		name: "every array value",
		value: [from, { ref: from }],
		expected: [to, { ref: to }],
		matches: 2,
	},
	{
		name: "byte-preserving serialized JSON",
		value:
			' \n{"frame.png": 0, "big":9007199254740993, "keep":"line\\nfeed", "ref":"fram\\u0065.png"}\t',
		expected:
			' \n{"frame.png": 0, "big":9007199254740993, "keep":"line\\nfeed", "ref":"kastard/job/frame.png"}\t',
		matches: 1,
	},
	{
		name: "nested serialized JSON",
		value: nested,
		expected: rewrittenNested,
		matches: 1,
	},
	{
		name: "nested JSON escape formatting",
		value: '{"nested":"\\u007b\\"ref\\":\\"frame.png\\"\\u007d"}',
		expected: '{"nested":"\\u007b\\"ref\\":\\"kastard/job/frame.png\\"\\u007d"}',
		matches: 1,
	},
	{
		name: "invalid and scalar JSON strings",
		value: ['"frame.png"', '{"ref":"frame.png"'],
		expected: ['"frame.png"', '{"ref":"frame.png"'],
		matches: 0,
	},
]) {
	test(scenario.name, () => {
		const collected = collectWorkflowInputStringLeaves(scenario.value);
		const rewritten = rewriteWorkflowInputStringLeaves(scenario.value, from, to);

		expect(collected.filter((value) => value === from)).toHaveLength(scenario.matches);
		expect(rewritten).toEqual({
			value: scenario.expected,
			replacements: scenario.matches,
		});
	});
}
