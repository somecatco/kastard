import { expect, test } from "vitest";
import { buttonVariants } from "@/components/ui/button";

test.each(["xs", "default", "sm", "lg", "icon"] as const)(
	"keeps the %s button fully rounded",
	(size) => {
		const classes = buttonVariants({ size }).split(" ");

		expect(classes).toContain("rounded-full");
	},
);

test.each([
	["xs", "h-6"],
	["sm", "h-7"],
	["default", "h-8"],
	["lg", "h-9"],
] as const)("uses the %s button height", (size, heightClass) => {
	expect(buttonVariants({ size }).split(" ")).toContain(heightClass);
});

test("keeps the icon button square", () => {
	const classes = buttonVariants({ size: "icon" }).split(" ");

	expect(classes).toContain("h-8");
	expect(classes).toContain("w-8");
});

test("uses the shadcn destructive colors", () => {
	const classes = buttonVariants({ variant: "destructive" }).split(" ");

	expect(classes).toContain("bg-destructive/10");
	expect(classes).toContain("text-destructive");
	expect(classes).toContain("hover:bg-destructive/20");
	expect(classes).toContain("dark:bg-destructive/20");
	expect(classes).toContain("dark:hover:bg-destructive/30");
});
