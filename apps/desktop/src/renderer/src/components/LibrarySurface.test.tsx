import { render, screen, within } from "@testing-library/react";
import { BoxesIcon } from "lucide-react";
import { expect, test } from "vitest";
import "../App.test-harness";
import { LibrarySurface } from "./LibrarySurface";

test("renders the shared header, summary, error, and loading state", async () => {
	render(
		<LibrarySurface
			title="Model Library"
			description="Register model references."
			action={<button type="button">Add Model</button>}
			directory="model-library"
			summary={{
				label: "Model library summary",
				items: [
					{ label: "All", value: 2 },
					{ label: "Sync", value: 1 },
				],
			}}
			error="Could not load models."
			loadingLabel="Loading models…"
			emptyState={null}
		/>,
	);

	const surface = screen.getByRole("region", { name: "Model Library" });
	expect(
		within(surface).getByRole("heading", { name: "Model Library" }),
	).toHaveAttribute("id", "model-library-title");
	expect(within(surface).getByText("Register model references.")).toBeVisible();
	expect(within(surface).getByRole("button", { name: "Add Model" })).toBeVisible();
	expect(within(surface).getByLabelText("Model library summary")).toHaveTextContent(
		"All2Sync1",
	);
	expect(within(surface).getByRole("alert")).toHaveTextContent(
		"Could not load models.",
	);
	expect(
		within(surface).getByText("Loading models…").closest('[role="status"]'),
	).toBeVisible();
	expect(
		await within(surface).findByText("/Users/test/Kastard/comfy/virtual-models"),
	).toBeVisible();
});

test("renders the shared empty state", () => {
	render(
		<LibrarySurface
			title="Model Library"
			description="Register model references."
			directory="model-library"
			summary={null}
			error={null}
			loadingLabel={null}
			emptyState={{
				icon: BoxesIcon,
				title: "No models registered",
				description: "Add a model reference to get started.",
			}}
		/>,
	);

	expect(screen.getByRole("heading", { name: "No models registered" })).toBeVisible();
	expect(screen.getByText("Add a model reference to get started.")).toBeVisible();
});

test("renders no content for a failed load and wraps ready rows", () => {
	const commonProps = {
		title: "Custom Nodes",
		description: "Choose packages to sync.",
		directory: "custom-nodes" as const,
		summary: null,
		loadingLabel: null,
		emptyState: null,
	};
	const { rerender } = render(
		<LibrarySurface {...commonProps} error="Could not load custom nodes." />,
	);

	expect(screen.getByRole("alert")).toHaveTextContent("Could not load custom nodes.");
	expect(screen.queryByRole("article")).not.toBeInTheDocument();

	rerender(
		<LibrarySurface {...commonProps} error={null}>
			<article>ComfyUI Example Node</article>
		</LibrarySurface>,
	);

	expect(screen.getByRole("article")).toHaveTextContent("ComfyUI Example Node");
});
