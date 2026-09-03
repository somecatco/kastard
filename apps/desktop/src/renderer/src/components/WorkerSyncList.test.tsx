import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
	WorkerSyncActionMenu,
	WorkerSyncActionMenuItem,
	WorkerSyncCancelButton,
	WorkerSyncList,
	WorkerSyncListRow,
} from "@/components/WorkerSyncList";

afterEach(cleanup);

test("renders the shared status structure and dismisses its item menu from list content", async () => {
	const onAction = vi.fn();
	render(<Fixture onAction={onAction} />);

	const list = screen.getByRole("region", { name: "Artifacts" });
	expect(list).toHaveClass("select-text", "cursor-text");
	expect(screen.getByText("1 artifact ready · 1/2")).toHaveAttribute("role", "status");
	expect(
		screen.getByRole("progressbar", { name: "Artifact synchronization" }),
	).toHaveAttribute("aria-valuenow", "1");
	expect(screen.getByText("1 MB / 2 MB")).toBeVisible();
	expect(
		screen.getByText("Worker status belongs to a previous Editor target."),
	).toBeVisible();
	expect(screen.getByRole("alert")).toHaveTextContent("Artifact unavailable.");
	expect(screen.getByRole("listitem", { name: "Artifact: Ready" })).toBeVisible();

	const actions = screen.getByRole("button", { name: "Actions for Artifact" });
	expect(actions).toHaveAttribute("aria-haspopup", "dialog");
	fireEvent.click(actions);
	expect(
		await screen.findByRole("dialog", { name: "Actions for Artifact" }),
	).toBeVisible();

	fireEvent.pointerDown(screen.getByRole("heading", { name: "Artifacts" }), {
		pointerType: "mouse",
	});
	await waitFor(() =>
		expect(
			screen.queryByRole("dialog", { name: "Actions for Artifact" }),
		).not.toBeInTheDocument(),
	);
	expect(list).toBeInTheDocument();

	fireEvent.click(actions);
	fireEvent.click(await screen.findByRole("button", { name: "Refresh artifact" }));
	expect(onAction).toHaveBeenCalledOnce();
});

test("focuses its popover action and closes it with Escape", async () => {
	render(<Fixture onAction={() => undefined} />);

	const trigger = screen.getByRole("button", { name: "Actions for Artifact" });
	trigger.focus();
	fireEvent.click(trigger);
	const action = await screen.findByRole("button", { name: "Refresh artifact" });
	await waitFor(() => expect(action).toHaveFocus());

	fireEvent.keyDown(action, { key: "Escape" });
	await waitFor(() =>
		expect(
			screen.queryByRole("dialog", { name: "Actions for Artifact" }),
		).not.toBeInTheDocument(),
	);
	expect(trigger).toHaveFocus();
});

function Fixture({ onAction }: { onAction: () => void }): React.JSX.Element {
	const [menuOpen, setMenuOpen] = useState(false);
	return (
		<WorkerSyncList
			titleId="artifact-status-title"
			title="Artifacts"
			status="1 artifact ready · 1/2"
			action={
				<WorkerSyncCancelButton
					description="artifact synchronization"
					canceling={false}
					onCancel={() => undefined}
				/>
			}
			progressLabel="Artifact synchronization"
			progressValue={1}
			progressMax={2}
			progressDetail="1 MB / 2 MB"
			targetStatus="stale"
			error="Artifact unavailable."
			onDismissActionMenu={() => setMenuOpen(false)}
		>
			<WorkerSyncListRow
				ariaLabel="Artifact: Ready"
				icon={<span aria-hidden="true">✓</span>}
				content={<span>Artifact</span>}
				status={<span>Ready</span>}
				action={
					<WorkerSyncActionMenu
						open={menuOpen}
						disabled={false}
						busy={false}
						ariaLabel="Actions for Artifact"
						onOpenChange={setMenuOpen}
					>
						<WorkerSyncActionMenuItem
							icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
							onClick={() => {
								setMenuOpen(false);
								onAction();
							}}
						>
							Refresh artifact
						</WorkerSyncActionMenuItem>
					</WorkerSyncActionMenu>
				}
			/>
		</WorkerSyncList>
	);
}
