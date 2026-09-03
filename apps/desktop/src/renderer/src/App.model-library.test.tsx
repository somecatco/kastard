import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type {
	ModelLibraryEntry,
	ModelLibraryInput,
	ModelLibraryMutationResult,
} from "../../shared/api";
import { App } from "./App";
import "./App.test-harness";

const fluxArtifact = {
	provider: "huggingface" as const,
	modelId: "black-forest-labs/FLUX.1-dev",
	versionId: "3de623fc3c33e44ffbe2bad470d0f45bccf2eb21",
	versionLabel: "3de623f",
	fileId: "flux1-dev.safetensors",
	fileName: "flux1-dev.safetensors",
	sizeBytes: 23_802_932_552,
};
const fluxArtifactValue = [
	fluxArtifact.provider,
	fluxArtifact.modelId,
	fluxArtifact.versionId,
	fluxArtifact.fileId,
].join(":");

test("registers a model and refreshes the ComfyUI frame", async () => {
	const model: ModelLibraryEntry = {
		id: "flux",
		name: "FLUX.1 Dev",
		sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
		path: "diffusion_models/flux1-dev.safetensors",
		sync: true,
		artifact: fluxArtifact,
	};
	vi.mocked(window.kastard.models.add).mockResolvedValue({ ok: true, model });
	vi.mocked(window.kastard.models.update).mockImplementation(async ({ id, input }) => ({
		ok: true,
		model: { id, ...input },
	}));
	vi.mocked(window.kastard.models.resolveFiles).mockResolvedValue({
		ok: true,
		modelName: model.name,
		files: [fluxArtifact],
	});
	render(<App />);

	const comfyFrame = await screen.findByTitle("ComfyUI");
	const modelLibraryButton = screen.getByRole("button", { name: "Model Library" });
	fireEvent.click(modelLibraryButton);

	expect(modelLibraryButton).toHaveAttribute("aria-current", "page");
	expect(await screen.findByText("No models registered")).toBeVisible();
	expect(
		screen.getByText("Add a Hugging Face or CivitAI model to get started."),
	).toBeVisible();
	expect(screen.getByLabelText("Model library summary")).toHaveTextContent(
		"All0Sync0Sync size0 B",
	);
	fireEvent.click(screen.getByRole("button", { name: "Add Model" }));
	expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
	expect(screen.queryByLabelText("ComfyUI folder")).not.toBeInTheDocument();
	expect(screen.getByLabelText("Source URL")).toHaveAttribute(
		"placeholder",
		"Paste a model URL",
	);
	fireEvent.change(screen.getByLabelText("Source URL"), {
		target: { value: model.sourceUrl },
	});
	fireEvent.click(screen.getByRole("button", { name: "Load Model Info" }));
	await waitFor(() =>
		expect(window.kastard.models.resolveFiles).toHaveBeenCalledWith({
			sourceUrl: model.sourceUrl,
		}),
	);
	expect(await screen.findByLabelText("Name")).toHaveValue(model.name);
	expect(screen.getByLabelText("Provider file")).toHaveValue(fluxArtifactValue);
	const folderSelect = screen.getByLabelText("ComfyUI folder") as HTMLSelectElement;
	expect(folderSelect).toHaveValue("checkpoints");
	const folderNames = Array.from(folderSelect.options).map((option) => option.text);
	expect(folderNames).toContain("diffusion_models");
	expect(folderNames).toContain("LLM");
	expect(folderNames).toContain("unet");
	expect(folderNames.every((name) => name === "LLM" || /^[a-z0-9_]+$/.test(name))).toBe(
		true,
	);
	expect(screen.getByLabelText("Path")).toHaveValue(
		"checkpoints/flux1-dev.safetensors",
	);
	fireEvent.change(folderSelect, {
		target: { value: "LLM" },
	});
	expect(screen.getByLabelText("Path")).toHaveValue("LLM/flux1-dev.safetensors");
	fireEvent.change(folderSelect, {
		target: { value: "diffusion_models" },
	});
	expect(screen.getByLabelText("Path")).toHaveValue(model.path);
	expect(
		screen.getByRole("switch", {
			name: "Sync this model to the Worker",
		}),
	).toBeChecked();
	fireEvent.click(screen.getByRole("button", { name: "Save" }));

	await waitFor(() =>
		expect(window.kastard.models.add).toHaveBeenCalledWith({
			name: model.name,
			sourceUrl: model.sourceUrl,
			path: model.path,
			sync: true,
			artifact: fluxArtifact,
		}),
	);
	expect(await screen.findByText(model.name)).toBeVisible();
	expect(screen.getByLabelText("Model library summary")).toHaveTextContent(
		"All1Sync1Sync size22.2 GB",
	);
	const sync = screen.getByRole("switch", { name: `Sync ${model.name}` });
	expect(sync).toBeChecked();
	fireEvent.click(sync);
	await waitFor(() =>
		expect(window.kastard.models.update).toHaveBeenCalledWith({
			id: model.id,
			input: {
				name: model.name,
				sourceUrl: model.sourceUrl,
				path: model.path,
				sync: false,
				artifact: fluxArtifact,
			},
		}),
	);
	await waitFor(() => expect(sync).not.toBeChecked());
	expect(screen.getByLabelText("Model library summary")).toHaveTextContent(
		"All1Sync0Sync size0 B",
	);

	fireEvent.click(screen.getByRole("button", { name: `Edit ${model.name}` }));
	expect(screen.getByLabelText("Source URL")).toHaveValue(model.sourceUrl);
	expect(screen.getByLabelText("Path")).toHaveValue(model.path);
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "FLUX Dev" },
	});
	fireEvent.change(screen.getByLabelText("Path"), {
		target: { value: "diffusion_models/flux-dev.safetensors" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Reload Model Info" }));
	await waitFor(() =>
		expect(window.kastard.models.resolveFiles).toHaveBeenCalledTimes(2),
	);
	expect(screen.getByLabelText("Name")).toHaveValue("FLUX Dev");
	expect(screen.getByLabelText("Path")).toHaveValue(
		"diffusion_models/flux-dev.safetensors",
	);
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() =>
		expect(window.kastard.models.update).toHaveBeenLastCalledWith({
			id: model.id,
			input: {
				name: "FLUX Dev",
				sourceUrl: model.sourceUrl,
				path: "diffusion_models/flux-dev.safetensors",
				sync: false,
				artifact: fluxArtifact,
			},
		}),
	);
	expect(await screen.findByText("FLUX Dev")).toBeVisible();

	fireEvent.click(screen.getByRole("button", { name: "ComfyUI" }));
	expect(screen.getByTitle("ComfyUI")).not.toBe(comfyFrame);
});

test("keeps rapid model sync selections optimistic while saving in order", async () => {
	const model: ModelLibraryEntry = {
		id: "flux",
		name: "FLUX.1 Dev",
		sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
		path: "diffusion_models/flux1-dev.safetensors",
		sync: true,
		artifact: fluxArtifact,
	};
	vi.mocked(window.kastard.models.list).mockResolvedValue({
		ok: true,
		models: [model],
	});
	const pending: Array<{
		input: ModelLibraryInput;
		resolve: (result: ModelLibraryMutationResult) => void;
	}> = [];
	vi.mocked(window.kastard.models.update).mockImplementation(
		({ input }) =>
			new Promise((resolve) => {
				pending.push({ input, resolve });
			}),
	);
	render(<App />);

	const comfyFrame = await screen.findByTitle("ComfyUI");
	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	const sync = await screen.findByRole("switch", { name: `Sync ${model.name}` });
	const addModel = screen.getByRole("button", { name: "Add Model" });

	fireEvent.click(sync);
	expect(sync).not.toBeChecked();
	expect(sync).toBeEnabled();
	expect(addModel).toBeEnabled();
	fireEvent.click(sync);
	expect(sync).toBeChecked();

	await waitFor(() => expect(window.kastard.models.update).toHaveBeenCalledTimes(1));
	const first = pending[0];
	if (!first) throw new Error("The first model update was not started.");
	await act(async () => {
		first.resolve({ ok: true, model: { id: model.id, ...first.input } });
	});
	await waitFor(() => expect(window.kastard.models.update).toHaveBeenCalledTimes(2));
	expect(sync).toBeChecked();

	const second = pending[1];
	if (!second) throw new Error("The second model update was not started.");
	await act(async () => {
		second.resolve({ ok: true, model: { id: model.id, ...second.input } });
	});
	await waitFor(() => expect(sync).toBeChecked());
	expect(first.input.sync).toBe(false);
	expect(second.input.sync).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "ComfyUI" }));
	expect(screen.getByTitle("ComfyUI")).toBe(comfyFrame);
});

test("keeps the empty state visible when loading models fails", async () => {
	vi.mocked(window.kastard.models.list).mockResolvedValue({
		ok: false,
		error: "The Model Library could not be loaded.",
	});
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"The Model Library could not be loaded.",
	);
	expect(screen.getByText("No models registered")).toBeVisible();
	expect(screen.queryByLabelText("Model library summary")).not.toBeInTheDocument();
});

test("restores the confirmed model sync selection when saving fails", async () => {
	const model: ModelLibraryEntry = {
		id: "flux",
		name: "FLUX.1 Dev",
		sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
		path: "diffusion_models/flux1-dev.safetensors",
		sync: true,
		artifact: fluxArtifact,
	};
	vi.mocked(window.kastard.models.list).mockResolvedValue({
		ok: true,
		models: [model],
	});
	let finishUpdate = (_result: ModelLibraryMutationResult): void => undefined;
	vi.mocked(window.kastard.models.update).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishUpdate = resolve;
			}),
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	const sync = await screen.findByRole("switch", { name: `Sync ${model.name}` });
	fireEvent.click(sync);
	expect(sync).not.toBeChecked();
	expect(sync).toBeEnabled();
	await waitFor(() => expect(window.kastard.models.update).toHaveBeenCalledOnce());

	await act(async () => {
		finishUpdate({ ok: false, error: "The model sync setting could not be saved." });
	});
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"The model sync setting could not be saved.",
	);
	expect(sync).toBeChecked();
});

test("shows supported model sources on hover and registers a CivitAI AIR", async () => {
	const air = "civitai:1318945@3218603";
	const sourceUrl = "https://civitai.com/models/1318945?modelVersionId=3218603";
	const artifact = {
		provider: "civitai" as const,
		modelId: "1318945",
		versionId: "3218603",
		versionLabel: "v24",
		fileId: "3100615",
		fileName: "oneObsession_v24.safetensors",
		sizeBytes: 6_938_040_682,
	};
	const model: ModelLibraryEntry = {
		id: "one-obsession",
		name: "One obsession",
		sourceUrl,
		path: "checkpoints/oneObsession_v24.safetensors",
		sync: true,
		artifact,
	};
	vi.mocked(window.kastard.models.resolveFiles).mockResolvedValue({
		ok: true,
		modelName: model.name,
		files: [artifact],
	});
	vi.mocked(window.kastard.models.add).mockResolvedValue({ ok: true, model });
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	await screen.findByText("No models registered");
	fireEvent.click(screen.getByRole("button", { name: "Add Model" }));

	const sourceInput = screen.getByLabelText("Source URL");
	expect(sourceInput).toHaveAttribute("type", "text");
	const sourceLabel = screen.getByText("Source URL", { selector: "label" });
	const supportedUrls = screen.getByRole("button", { name: "Supported URLs" });
	expect(sourceLabel.parentElement).toContainElement(supportedUrls);
	expect(supportedUrls.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

	fireEvent.pointerMove(supportedUrls, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");
	expect(within(tooltip).getByText("Examples")).toBeVisible();
	const examples = [
		"https://huggingface.co/black-forest-labs/FLUX.1-dev",
		"https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/blob/main/v1-5-pruned-emaonly-fp16.safetensors",
		"https://civitai.com/models/1318945?modelVersionId=3218603",
		air,
		"urn:air:sdxl:checkpoint:civitai:1318945@3218603",
	];
	expect(
		within(tooltip)
			.getAllByRole("listitem")
			.map((item) => item.textContent),
	).toEqual(examples);
	for (const example of examples) {
		expect(within(tooltip).getByText(example)).toHaveClass("break-all");
	}

	fireEvent.pointerLeave(supportedUrls, { pointerType: "mouse" });
	await waitFor(() => expect(tooltip).not.toBeInTheDocument());
	expect(screen.getByRole("dialog", { name: "Add Model" })).toBeVisible();

	fireEvent.change(sourceInput, { target: { value: air } });
	fireEvent.click(screen.getByRole("button", { name: "Load Model Info" }));
	await waitFor(() =>
		expect(window.kastard.models.resolveFiles).toHaveBeenCalledWith({ sourceUrl }),
	);
	expect(await screen.findByLabelText("Name")).toHaveValue(model.name);
	expect(screen.getByLabelText("Source URL")).toHaveValue(sourceUrl);
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() =>
		expect(window.kastard.models.add).toHaveBeenCalledWith({
			name: model.name,
			sourceUrl,
			path: model.path,
			sync: true,
			artifact,
		}),
	);
});

test("keeps the model editor dismissable while provider metadata is loading", async () => {
	let finishLookup: () => void = () => undefined;
	vi.mocked(window.kastard.models.resolveFiles).mockReturnValueOnce(
		new Promise((resolve) => {
			finishLookup = () =>
				resolve({ ok: true, modelName: "FLUX.1 Dev", files: [fluxArtifact] });
		}),
	);
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	await screen.findByText("No models registered");
	fireEvent.click(screen.getByRole("button", { name: "Add Model" }));
	fireEvent.change(screen.getByLabelText("Source URL"), {
		target: { value: "https://huggingface.co/black-forest-labs/FLUX.1-dev" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Load Model Info" }));
	expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

	await act(async () => finishLookup());
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("refreshes untouched model fields from updated provider metadata", async () => {
	const refreshedArtifact = {
		...fluxArtifact,
		fileId: "flux1-dev-v2.safetensors",
		fileName: "flux1-dev-v2.safetensors",
	};
	vi.mocked(window.kastard.models.resolveFiles)
		.mockResolvedValueOnce({
			ok: true,
			modelName: "FLUX.1 Dev",
			files: [fluxArtifact],
		})
		.mockResolvedValueOnce({
			ok: true,
			modelName: "FLUX.1 Dev V2",
			files: [refreshedArtifact],
		});
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	await screen.findByText("No models registered");
	fireEvent.click(screen.getByRole("button", { name: "Add Model" }));
	fireEvent.change(screen.getByLabelText("Source URL"), {
		target: { value: "https://huggingface.co/black-forest-labs/FLUX.1-dev" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Load Model Info" }));
	expect(await screen.findByLabelText("Name")).toHaveValue("FLUX.1 Dev");
	expect(screen.getByLabelText("Path")).toHaveValue(
		"checkpoints/flux1-dev.safetensors",
	);

	fireEvent.click(screen.getByRole("button", { name: "Reload Model Info" }));
	await waitFor(() =>
		expect(window.kastard.models.resolveFiles).toHaveBeenCalledTimes(2),
	);
	expect(screen.getByLabelText("Name")).toHaveValue("FLUX.1 Dev V2");
	expect(screen.getByLabelText("Path")).toHaveValue(
		"checkpoints/flux1-dev-v2.safetensors",
	);
});

test("builds a model path after choosing among multiple provider files", async () => {
	const vaeArtifact = {
		...fluxArtifact,
		fileId: "vae/ae.safetensors",
		fileName: "vae/ae.safetensors",
		sizeBytes: 335_304_388,
	};
	const unetArtifact = {
		...fluxArtifact,
		fileId: "split_files/diffusion_models/flux1-dev.safetensors",
		fileName: "split_files/diffusion_models/flux1-dev.safetensors",
	};
	vi.mocked(window.kastard.models.resolveFiles).mockResolvedValue({
		ok: true,
		modelName: "FLUX.1 Dev",
		files: [vaeArtifact, unetArtifact],
	});
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	await screen.findByText("No models registered");
	fireEvent.click(screen.getByRole("button", { name: "Add Model" }));
	fireEvent.change(screen.getByLabelText("Source URL"), {
		target: { value: "https://huggingface.co/black-forest-labs/FLUX.1-dev" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Load Model Info" }));

	expect(await screen.findByLabelText("Name")).toHaveValue("FLUX.1 Dev");
	expect(screen.getByLabelText("Provider file")).toHaveValue("");
	expect(screen.getByLabelText("ComfyUI folder")).toHaveValue("checkpoints");
	expect(screen.getByLabelText("Path")).toHaveValue("");
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "Custom FLUX" },
	});
	fireEvent.change(screen.getByLabelText("Path"), {
		target: { value: "custom_models/custom-flux.safetensors" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Reload Model Info" }));
	await waitFor(() =>
		expect(window.kastard.models.resolveFiles).toHaveBeenCalledTimes(2),
	);
	expect(screen.getByLabelText("Name")).toHaveValue("Custom FLUX");
	expect(screen.getByLabelText("Path")).toHaveValue(
		"custom_models/custom-flux.safetensors",
	);
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Select a provider model file.",
	);

	fireEvent.change(screen.getByLabelText("Provider file"), {
		target: {
			value: [
				unetArtifact.provider,
				unetArtifact.modelId,
				unetArtifact.versionId,
				unetArtifact.fileId,
			].join(":"),
		},
	});
	expect(screen.getByLabelText("ComfyUI folder")).toHaveValue("diffusion_models");
	expect(screen.getByLabelText("Path")).toHaveValue(
		"diffusion_models/flux1-dev.safetensors",
	);
	fireEvent.change(screen.getByLabelText("ComfyUI folder"), {
		target: { value: "vae" },
	});
	expect(screen.getByLabelText("Path")).toHaveValue("vae/flux1-dev.safetensors");
	fireEvent.change(screen.getByLabelText("Path"), {
		target: { value: "custom_models/custom-flux.safetensors" },
	});
	expect(screen.getByLabelText("ComfyUI folder")).toHaveValue("custom_models");
	expect(window.kastard.models.add).not.toHaveBeenCalled();
});

test("marks synced models with unavailable sizes and shows provider lookup errors", async () => {
	const model: ModelLibraryEntry = {
		id: "legacy",
		name: "Legacy model",
		sourceUrl: "https://huggingface.co/example/legacy",
		path: "checkpoints/legacy.safetensors",
		sync: true,
		artifact: null,
	};
	vi.mocked(window.kastard.models.list).mockResolvedValue({
		ok: true,
		models: [model],
	});
	vi.mocked(window.kastard.models.resolveFiles).mockResolvedValue({
		ok: false,
		error: "Access to this model requires a valid Hugging Face token.",
	});
	const updated = {
		...model,
		name: "Renamed legacy model",
		path: "checkpoints/renamed-legacy.safetensors",
	};
	vi.mocked(window.kastard.models.update).mockResolvedValue({
		ok: true,
		model: updated,
	});
	render(<App />);

	await screen.findByTitle("ComfyUI");
	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	expect(await screen.findByText("Provider file selection required")).toBeVisible();
	expect(screen.getByLabelText("Model library summary")).toHaveTextContent(
		"All1Sync1Sync size0 B· 1 sizes unavailable",
	);

	fireEvent.click(screen.getByRole("button", { name: `Edit ${model.name}` }));
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: updated.name },
	});
	fireEvent.change(screen.getByLabelText("Path"), {
		target: { value: updated.path },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() =>
		expect(window.kastard.models.update).toHaveBeenCalledWith({
			id: model.id,
			input: {
				name: updated.name,
				sourceUrl: model.sourceUrl,
				path: updated.path,
				sync: true,
				artifact: null,
			},
		}),
	);
	expect(await screen.findByText(updated.name)).toBeVisible();

	fireEvent.click(screen.getByRole("button", { name: `Edit ${updated.name}` }));
	fireEvent.click(screen.getByRole("button", { name: "Reload Model Info" }));
	const alert = await screen.findByRole("alert");
	expect(alert).toHaveTextContent("requires a valid Hugging Face token");
	const range = document.createRange();
	range.selectNodeContents(alert);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	expect(selection?.toString()).toContain("requires a valid Hugging Face token");
});

test("confirms model deletion and keeps the model when deletion fails", async () => {
	const model: ModelLibraryEntry = {
		id: "flux",
		name: "FLUX.1 Dev",
		sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
		path: "diffusion_models/flux1-dev.safetensors",
		sync: true,
		artifact: fluxArtifact,
	};
	vi.mocked(window.kastard.models.list).mockResolvedValue({
		ok: true,
		models: [model],
	});
	let finishDeletion = (_result: ModelLibraryMutationResult): void => undefined;
	vi.mocked(window.kastard.models.remove)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishDeletion = resolve;
				}),
		)
		.mockResolvedValueOnce({ ok: true, model });
	render(<App />);

	const comfyFrame = await screen.findByTitle("ComfyUI");
	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	expect(await screen.findByRole("heading", { name: model.name })).toBeVisible();
	expect(screen.getByRole("heading", { name: model.name })).toHaveClass("select-text");
	expect(screen.getByRole("link", { name: model.sourceUrl })).toHaveAttribute(
		"href",
		model.sourceUrl,
	);
	expect(screen.getByRole("link", { name: model.sourceUrl })).toHaveAttribute(
		"target",
		"_blank",
	);
	const path = screen.getByText(model.path);
	fireEvent.mouseDown(path, { button: 0, detail: 3 });
	const selection = window.getSelection();
	expect(selection?.toString()).toBe(model.path);
	fireEvent.pointerDown(screen.getByRole("heading", { name: "Model Library" }), {
		button: 0,
	});
	expect(selection?.toString()).toBe("");

	fireEvent.click(screen.getByRole("button", { name: `Delete ${model.name}` }));
	expect(screen.getByRole("dialog")).toHaveTextContent(
		`Remove ${model.name} from the Model Library?`,
	);
	expect(screen.getByRole("heading", { name: "Delete model?" })).toHaveClass(
		"select-text",
	);
	expect(screen.getByText(/This does not delete a downloaded model file/u)).toHaveClass(
		"select-text",
	);
	expect(window.kastard.models.remove).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(screen.getByRole("heading", { name: model.name })).toBeVisible();

	fireEvent.click(screen.getByRole("button", { name: `Delete ${model.name}` }));
	const deleteButton = screen.getByRole("button", { name: "Delete" });
	expect(deleteButton).toHaveClass("bg-destructive/10", "text-destructive");
	fireEvent.click(deleteButton);
	await waitFor(() => expect(window.kastard.models.remove).toHaveBeenCalledOnce());
	expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
	fireEvent.keyDown(document, { key: "Escape" });
	expect(screen.getByRole("dialog")).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Close" }));
	expect(screen.getByRole("dialog")).toBeVisible();

	await act(async () => {
		finishDeletion({ ok: false, error: "Virtual model projection failed." });
	});
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Virtual model projection failed.",
	);
	expect(screen.getByText(model.name, { selector: "article h2" })).toBeInTheDocument();
	expect(window.kastard.models.remove).toHaveBeenLastCalledWith({ id: model.id });
	expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	expect(await screen.findByText("No models registered")).toBeVisible();
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(window.kastard.models.remove).toHaveBeenCalledTimes(2);

	fireEvent.click(screen.getByRole("button", { name: "ComfyUI" }));
	expect(screen.getByTitle("ComfyUI")).not.toBe(comfyFrame);
});

test("shows model editor validation errors as alerts without native validation", async () => {
	vi.mocked(window.kastard.models.resolveFiles).mockResolvedValue({
		ok: true,
		modelName: "FLUX.1 Dev",
		files: [fluxArtifact],
	});
	render(<App />);

	fireEvent.click(screen.getByRole("button", { name: "Model Library" }));
	await screen.findByText("No models registered");
	fireEvent.click(screen.getByRole("button", { name: "Add Model" }));
	const loadButton = screen.getByRole("button", { name: "Load Model Info" });
	const form = loadButton.closest("form");
	expect(form).toHaveAttribute("novalidate");

	fireEvent.click(loadButton);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Enter a supported model URL.",
	);
	fireEvent.change(screen.getByLabelText("Source URL"), {
		target: { value: "https://example.com/model" },
	});
	fireEvent.click(loadButton);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Enter a supported model URL.",
	);
	fireEvent.change(screen.getByLabelText("Source URL"), {
		target: { value: "https://huggingface.co/black-forest-labs/FLUX.1-dev" },
	});
	fireEvent.click(loadButton);
	const saveButton = await screen.findByRole("button", { name: "Save" });
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
	fireEvent.click(saveButton);
	expect(await screen.findByRole("alert")).toHaveTextContent("Enter a model name.");
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "FLUX.1 Dev" },
	});
	fireEvent.change(screen.getByLabelText("Path"), { target: { value: "" } });
	fireEvent.click(saveButton);
	expect(await screen.findByRole("alert")).toHaveTextContent("Enter a model path.");
	expect(window.kastard.models.add).not.toHaveBeenCalled();
});
