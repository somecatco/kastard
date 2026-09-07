import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { connectedState, emitConnection, emitWorkerSession } from "@/App.test-harness";
import { useNodesRequests } from "@/hooks/use-worker-nodes-requests";
import type { WorkerCustomNodeSyncResult } from "../../../../shared/api";
import { useConnectionDialogs } from "./ConnectionDialogs";
import { ConnectionProvider } from "./ConnectionProvider";

const node = { name: "example-node", managerId: "example-node", version: "1.0.0" };
const model = {
	name: "Example",
	path: "checkpoints/example.safetensors",
	artifact: {
		provider: "huggingface" as const,
		modelId: "example/model",
		versionId: "main",
		versionLabel: "main",
		fileId: "example.safetensors",
		fileName: "example.safetensors",
		sizeBytes: 100,
	},
};
function Confirmations() {
	const actions = useConnectionDialogs();
	return (
		<>
			<button
				type="button"
				onClick={() => actions.requestCustomNodeReinstall(node.name)}
			>
				Reinstall
			</button>
			<button type="button" onClick={() => actions.requestCustomNodeRemoval(node)}>
				Remove
			</button>
			<button type="button" onClick={() => actions.requestModelRedownload(model.path)}>
				Redownload
			</button>
		</>
	);
}

test.each([
	["Reinstall", "Force reinstall custom node?", "reinstallCustomNode"],
	["Remove", "Delete custom node from Worker?", "removeCustomNode"],
	["Redownload", "Force redownload model?", "redownloadModel"],
] as const)(
	"invalidates the %s confirmation when the connection is replaced",
	async (action, title, operation) => {
		render(
			<ConnectionProvider closeRequest={0}>
				<Confirmations />
			</ConnectionProvider>,
		);
		const connection = connectedState();
		await act(async () => {
			emitConnection(connection);
			emitWorkerSession({
				models: {
					status: "idle",
					models: null,
					targetStatus: "current",
					targetModels: [{ target: model, status: "ready", downloadedBytes: 100 }],
				},
			});
		});
		fireEvent.click(screen.getByRole("button", { name: action }));
		const confirmation = screen.getByRole("dialog", { name: title });
		expect(confirmation).toBeVisible();
		act(() =>
			emitConnection({ ...connection, connectedAt: connection.connectedAt + 1 }),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument(),
		);
		expect(window.kastard.workerSession[operation]).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: action }));
		expect(screen.getByRole("dialog", { name: title })).toBeVisible();
	},
);

test("retains a request failure after closing its consumer and reopening it", async () => {
	let resolve!: (result: WorkerCustomNodeSyncResult) => void;
	vi.mocked(window.kastard.workerSession.syncCustomNodes).mockReturnValue(
		new Promise((done) => {
			resolve = done;
		}),
	);
	function Requests() {
		const request = useNodesRequests();
		return (
			<>
				<button
					type="button"
					onClick={() => void request.syncCustomNodes()}
					disabled={request.syncAction}
				>
					Sync
				</button>
				<span>{request.syncError}</span>
			</>
		);
	}
	const view = render(
		<ConnectionProvider closeRequest={0}>
			<Requests />
		</ConnectionProvider>,
	);
	await act(async () => emitConnection(connectedState()));
	fireEvent.click(screen.getByRole("button", { name: "Sync" }));
	expect(screen.getByRole("button", { name: "Sync" })).toBeDisabled();
	view.rerender(<ConnectionProvider closeRequest={1}>{null}</ConnectionProvider>);
	await act(async () => resolve({ ok: false, error: "Node installation failed" }));
	view.rerender(
		<ConnectionProvider closeRequest={1}>
			<Requests />
		</ConnectionProvider>,
	);
	expect(screen.getByText("Node installation failed")).toBeVisible();
	expect(screen.getByRole("button", { name: "Sync" })).toBeEnabled();
});
