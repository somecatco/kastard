import {
	BoxesIcon,
	CircleHelpIcon,
	LoaderCircleIcon,
	PencilIcon,
	PlusIcon,
	TrashIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AppFormDialog } from "@/components/AppFormDialog";
import { Input } from "@/components/common/input";
import { Select } from "@/components/common/select";
import { Switch } from "@/components/common/switch";
import { LibrarySurface } from "@/components/LibrarySurface";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOptimisticUpdateQueue } from "@/hooks/useOptimisticUpdateQueue";
import { selectTextOnTripleClick } from "@/lib/text-selection";
import type {
	ModelArtifact,
	ModelLibraryEntry,
	ModelLibraryInput,
} from "../../../shared/api";
import {
	DEFAULT_MODEL_PATH_CATEGORY,
	isModelPathCategory,
	MODEL_PATH_CATEGORIES,
} from "../../../shared/model-path";
import { normalizeModelSourceUrl } from "../../../shared/model-source";

type ModelLibrarySurfaceProps = {
	onCatalogChanged: () => void;
};

type ModelLibraryStatsValue = {
	total: number;
	sync: number;
	syncSizeBytes: number;
	unresolvedSync: number;
};

const MODEL_SOURCE_HOSTS = new Set(["huggingface.co", "civit.ai", "civitai.com"]);
const MODEL_SOURCE_EXAMPLES = [
	"https://huggingface.co/black-forest-labs/FLUX.1-dev",
	"https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/blob/main/v1-5-pruned-emaonly-fp16.safetensors",
	"https://civitai.com/models/1318945?modelVersionId=3218603",
	"civitai:1318945@3218603",
	"urn:air:sdxl:checkpoint:civitai:1318945@3218603",
] as const;
const MODEL_SOURCE_PLACEHOLDER = "Paste a model URL";
type EditorState = {
	phase: "source" | "details";
	category: string;
	nameEdited: boolean;
	pathEdited: boolean;
	input: ModelLibraryInput;
	files: ModelArtifact[];
} & ({ mode: "add" } | { mode: "edit"; model: ModelLibraryEntry });

const EMPTY_MODEL: ModelLibraryInput = {
	name: "",
	sourceUrl: "",
	path: "",
	sync: true,
	artifact: null,
};
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const BYTE_FORMATTER = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function ModelLibrarySurface({
	onCatalogChanged,
}: ModelLibrarySurfaceProps): React.JSX.Element {
	const [models, setModels] = useState<ModelLibraryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [resolvingFiles, setResolvingFiles] = useState(false);
	const mutationInFlight = useRef(false);
	const {
		confirm: confirmModelSync,
		enqueue: enqueueModelSync,
		forget: forgetModelSync,
		pendingKeys: pendingModelSyncIds,
	} = useOptimisticUpdateQueue<string, boolean>();
	const fileRequest = useRef(0);
	const [editor, setEditor] = useState<EditorState | null>(null);
	const [pendingDeletion, setPendingDeletion] = useState<ModelLibraryEntry | null>(
		null,
	);
	const changeEditor = useCallback((next: EditorState | null) => {
		if (next === null) {
			fileRequest.current += 1;
			setResolvingFiles(false);
		}
		setEditor(next);
		setError(null);
	}, []);
	const changePendingDeletion = useCallback((model: ModelLibraryEntry | null) => {
		setPendingDeletion(model);
		setError(null);
	}, []);
	const stats = loading || !loaded ? null : modelLibraryStats(models);

	useEffect(() => {
		let active = true;
		void window.kastard.models
			.list()
			.then((result) => {
				if (!active) return;
				if (result.ok) {
					for (const model of result.models) {
						confirmModelSync(model.id, model.sync);
					}
					setModels(result.models);
					setLoaded(true);
				} else setError(result.error);
			})
			.catch((loadError: unknown) => {
				if (active) setError(errorMessage(loadError));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [confirmModelSync]);

	const updateModel = useCallback(
		async (model: ModelLibraryEntry, input: ModelLibraryInput): Promise<boolean> => {
			if (mutationInFlight.current) return false;
			mutationInFlight.current = true;
			setSaving(true);
			setError(null);
			try {
				const result = await window.kastard.models.update({ id: model.id, input });
				if (!result.ok) {
					setError(result.error);
					return false;
				}
				setModels((current) =>
					current.map((item) => (item.id === result.model.id ? result.model : item)),
				);
				confirmModelSync(result.model.id, result.model.sync);
				onCatalogChanged();
				return true;
			} catch (updateError) {
				setError(errorMessage(updateError));
				return false;
			} finally {
				mutationInFlight.current = false;
				setSaving(false);
			}
		},
		[confirmModelSync, onCatalogChanged],
	);

	const updateModelSync = useCallback(
		(model: ModelLibraryEntry, sync: boolean): void => {
			setModels((current) =>
				current.map((item) => (item.id === model.id ? { ...item, sync } : item)),
			);
			setError(null);
			void enqueueModelSync({
				key: model.id,
				previousValue: model.sync,
				formatError: errorMessage,
				save: async () => {
					const result = await window.kastard.models.update({
						id: model.id,
						input: { ...modelInput(model), sync },
					});
					return result.ok
						? { ok: true, value: result.model.sync, data: result.model }
						: result;
				},
				onSuccess: (savedModel, { latest }) => {
					if (latest) {
						setModels((current) =>
							current.map((item) => (item.id === savedModel.id ? savedModel : item)),
						);
						setError(null);
					}
				},
				onError: (message, { confirmed, latest }) => {
					if (!latest) return;
					setModels((current) =>
						current.map((item) =>
							item.id === model.id ? { ...item, sync: confirmed } : item,
						),
					);
					setError(message);
				},
			});
		},
		[enqueueModelSync],
	);

	const removeModel = useCallback(async (): Promise<void> => {
		if (pendingDeletion === null || mutationInFlight.current) return;
		mutationInFlight.current = true;
		setSaving(true);
		setError(null);
		try {
			const result = await window.kastard.models.remove({ id: pendingDeletion.id });
			if (!result.ok) {
				setError(result.error);
				return;
			}
			setModels((current) =>
				current.filter((model) => model.id !== pendingDeletion.id),
			);
			forgetModelSync(pendingDeletion.id);
			setPendingDeletion(null);
			onCatalogChanged();
		} catch (removeError) {
			setError(errorMessage(removeError));
		} finally {
			mutationInFlight.current = false;
			setSaving(false);
		}
	}, [forgetModelSync, onCatalogChanged, pendingDeletion]);

	const resolveEditorFiles = useCallback(async (): Promise<void> => {
		if (editor === null || resolvingFiles) return;
		const sourceInput = editor.input.sourceUrl;
		const sourceUrl = normalizeModelSourceUrl(sourceInput);
		if (!isSupportedModelSource(sourceInput)) {
			setError("Enter a supported model URL.");
			return;
		}
		const requestId = fileRequest.current + 1;
		fileRequest.current = requestId;
		setResolvingFiles(true);
		setError(null);
		try {
			const result = await window.kastard.models.resolveFiles({ sourceUrl });
			if (fileRequest.current !== requestId) return;
			if (!result.ok) {
				setError(result.error);
				return;
			}
			setEditor((current) => {
				if (current === null || current.input.sourceUrl !== sourceInput) {
					return current;
				}
				const artifact = result.files.length === 1 ? (result.files[0] ?? null) : null;
				const fillsName = current.mode === "add" && !current.nameEdited;
				const fillsPath = current.mode === "add" && !current.pathEdited;
				const category =
					fillsPath && artifact
						? suggestedModelCategory(artifact.fileName, current.category)
						: current.category;
				return {
					...current,
					phase: "details",
					category,
					files: result.files,
					input: {
						...current.input,
						sourceUrl,
						name: fillsName ? result.modelName : current.input.name,
						artifact,
						path: fillsPath
							? artifact
								? defaultModelPath(category, artifact.fileName)
								: ""
							: current.input.path,
					},
				};
			});
		} catch (resolveError) {
			if (fileRequest.current === requestId) setError(errorMessage(resolveError));
		} finally {
			if (fileRequest.current === requestId) setResolvingFiles(false);
		}
	}, [editor, resolvingFiles]);

	const saveEditor = useCallback(async (): Promise<void> => {
		if (editor === null || editor.phase !== "details" || mutationInFlight.current)
			return;
		if (!editor.input.name.trim()) {
			setError("Enter a model name.");
			return;
		}
		if (!isSupportedModelSource(editor.input.sourceUrl)) {
			setError("Enter a supported model URL.");
			return;
		}
		const keepsExistingUnresolvedArtifact =
			editor.mode === "edit" &&
			editor.model.artifact === null &&
			editor.input.sourceUrl === editor.model.sourceUrl;
		if (editor.input.artifact === null && !keepsExistingUnresolvedArtifact) {
			setError("Select a provider model file.");
			return;
		}
		if (!editor.input.path.trim()) {
			setError("Enter a model path.");
			return;
		}
		if (editor.mode === "edit") {
			if (await updateModel(editor.model, editor.input)) setEditor(null);
			return;
		}

		mutationInFlight.current = true;
		setSaving(true);
		setError(null);
		try {
			const result = await window.kastard.models.add(editor.input);
			if (!result.ok) {
				setError(result.error);
				return;
			}
			setModels((current) => [...current, result.model]);
			confirmModelSync(result.model.id, result.model.sync);
			setEditor(null);
			onCatalogChanged();
		} catch (addError) {
			setError(errorMessage(addError));
		} finally {
			mutationInFlight.current = false;
			setSaving(false);
		}
	}, [confirmModelSync, editor, onCatalogChanged, updateModel]);

	return (
		<>
			<LibrarySurface
				title="Model Library"
				description="Add models, including LoRAs, without downloading them locally."
				action={
					<Button
						type="button"
						disabled={saving}
						onClick={() =>
							changeEditor({
								mode: "add",
								phase: "source",
								category: DEFAULT_MODEL_PATH_CATEGORY,
								nameEdited: false,
								pathEdited: false,
								input: EMPTY_MODEL,
								files: [],
							})
						}
					>
						<PlusIcon />
						Add Model
					</Button>
				}
				directory="model-library"
				summary={
					stats === null
						? null
						: {
								label: "Model library summary",
								items: [
									{ label: "All", value: stats.total },
									{ label: "Sync", value: stats.sync },
									{
										label: "Sync size",
										value: (
											<>
												{formatBytes(stats.syncSizeBytes)}
												{stats.unresolvedSync > 0 ? (
													<span className="ml-1.5 text-muted-foreground">
														· {stats.unresolvedSync} sizes unavailable
													</span>
												) : null}
											</>
										),
									},
								],
							}
				}
				error={error && editor === null && pendingDeletion === null ? error : null}
				loadingLabel={loading ? "Loading models…" : null}
				emptyState={
					!loading && models.length === 0
						? {
								icon: BoxesIcon,
								title: "No models registered",
								description: "Add a Hugging Face or CivitAI model to get started.",
							}
						: null
				}
			>
				{!loading && models.length > 0
					? models.map((model) => {
							const syncSaving = pendingModelSyncIds.has(model.id);
							return (
								<article
									key={model.id}
									aria-busy={syncSaving}
									className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-5 border-b px-5 py-4 last:border-b-0"
								>
									<div className="min-w-0">
										<h2 className="cursor-text select-text truncate font-medium">
											{model.name}
										</h2>
										{/* biome-ignore lint/a11y/noStaticElementInteractions: Triple-click refines native text selection rather than adding a control. */}
										<span
											className="mt-1 block cursor-text select-text truncate font-mono text-xs text-muted-foreground"
											onMouseDown={selectTextOnTripleClick}
										>
											{model.path}
										</span>
										<a
											href={model.sourceUrl}
											target="_blank"
											rel="noreferrer"
											className="mt-1 block select-text truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										>
											{model.sourceUrl}
										</a>
										<p className="mt-1 cursor-text select-text truncate text-xs text-muted-foreground">
											{model.artifact
												? `${model.artifact.fileName} · ${formatBytes(model.artifact.sizeBytes)}`
												: "Provider file selection required"}
										</p>
									</div>
									<Switch
										label="Sync"
										aria-label={`Sync ${model.name}`}
										checked={model.sync}
										disabled={saving}
										onChange={(event) => {
											updateModelSync(model, event.currentTarget.checked);
										}}
									/>
									<div className="flex items-center gap-1">
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`Edit ${model.name}`}
											aria-disabled={syncSaving ? true : undefined}
											disabled={saving}
											onClick={() => {
												if (syncSaving) return;
												changeEditor({
													mode: "edit",
													phase: "details",
													category: modelPathCategory(model.path),
													nameEdited: true,
													pathEdited: true,
													model,
													input: modelInput(model),
													files: model.artifact ? [model.artifact] : [],
												});
											}}
										>
											<PencilIcon />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`Delete ${model.name}`}
											aria-disabled={syncSaving ? true : undefined}
											disabled={saving}
											className="text-destructive hover:bg-destructive/10 hover:text-destructive"
											onClick={() => {
												if (!syncSaving) changePendingDeletion(model);
											}}
										>
											<TrashIcon />
										</Button>
									</div>
								</article>
							);
						})
					: null}
			</LibrarySurface>

			<ModelEditorDialog
				editor={editor}
				error={error}
				saving={saving}
				resolvingFiles={resolvingFiles}
				onChange={changeEditor}
				onResolveFiles={resolveEditorFiles}
				onSave={saveEditor}
			/>
			<AppFormDialog
				open={pendingDeletion !== null}
				onOpenChange={(open) => !open && changePendingDeletion(null)}
				title="Delete model?"
				description={`Remove ${pendingDeletion?.name} from the Model Library? This does not delete a downloaded model file.`}
				onSubmit={(event) => {
					event.preventDefault();
					void removeModel();
				}}
				submitting={saving}
				submitLabel="Delete"
				submittingLabel="Deleting…"
				submitVariant="destructive"
				error={error}
			/>
		</>
	);
}

function ModelEditorDialog({
	editor,
	error,
	saving,
	resolvingFiles,
	onChange,
	onResolveFiles,
	onSave,
}: {
	editor: EditorState | null;
	error: string | null;
	saving: boolean;
	resolvingFiles: boolean;
	onChange: (editor: EditorState | null) => void;
	onResolveFiles: () => Promise<void>;
	onSave: () => Promise<void>;
}): React.JSX.Element {
	const artifactValue = editor?.input.artifact
		? artifactKey(editor.input.artifact)
		: "";
	const loadingInfo = editor?.phase === "source";

	return (
		<AppFormDialog
			open={editor !== null}
			onOpenChange={(open) => !open && onChange(null)}
			title={editor?.mode === "edit" ? "Edit Model" : "Add Model"}
			description={
				loadingInfo
					? "Enter a Hugging Face or CivitAI model URL."
					: "Choose a logical ComfyUI path; no model file is downloaded."
			}
			onSubmit={(event) => {
				event.preventDefault();
				void (loadingInfo ? onResolveFiles() : onSave());
			}}
			submitting={saving}
			submitDisabled={resolvingFiles}
			submitLabel={
				resolvingFiles ? "Loading…" : loadingInfo ? "Load Model Info" : "Save"
			}
			submittingLabel={resolvingFiles ? "Loading…" : "Saving…"}
			error={error}
		>
			<div className="grid gap-4">
				<ModelField
					label="Source URL"
					htmlFor="model-source-url"
					action={<SupportedModelSources />}
				>
					<div className={loadingInfo ? undefined : "flex items-center gap-2"}>
						<Input
							id="model-source-url"
							type="text"
							inputMode="url"
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							placeholder={MODEL_SOURCE_PLACEHOLDER}
							value={editor?.input.sourceUrl ?? ""}
							onChange={(event) => {
								if (editor === null) return;
								onChange({
									...editor,
									phase: "source",
									files: [],
									input: {
										...editor.input,
										sourceUrl: event.currentTarget.value,
										artifact: null,
									},
								});
							}}
							required
							autoFocus={loadingInfo}
						/>
						{!loadingInfo ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								disabled={resolvingFiles}
								onClick={() => void onResolveFiles()}
							>
								{resolvingFiles ? <LoaderCircleIcon className="animate-spin" /> : null}
								{resolvingFiles ? "Loading…" : "Reload Model Info"}
							</Button>
						) : null}
					</div>
				</ModelField>
				{editor?.phase === "details" ? (
					<>
						<ModelField label="Name" htmlFor="model-name">
							<Input
								id="model-name"
								value={editor.input.name}
								onChange={(event) =>
									onChange({
										...editor,
										nameEdited: true,
										input: { ...editor.input, name: event.currentTarget.value },
									})
								}
								required
								autoFocus={editor.mode === "edit"}
							/>
						</ModelField>
						{editor.files.length > 0 ? (
							<ModelField label="Provider file" htmlFor="model-provider-file">
								<Select
									id="model-provider-file"
									value={artifactValue}
									onChange={(event) => {
										const artifact = editor.files.find(
											(file) => artifactKey(file) === event.currentTarget.value,
										);
										if (!artifact) {
											onChange({
												...editor,
												pathEdited: false,
												input: { ...editor.input, artifact: null, path: "" },
											});
											return;
										}
										const category = suggestedModelCategory(
											artifact.fileName,
											editor.category,
										);
										onChange({
											...editor,
											category,
											pathEdited: false,
											input: {
												...editor.input,
												artifact,
												path: defaultModelPath(category, artifact.fileName),
											},
										});
									}}
									className="w-full"
								>
									<option value="">Select a model file</option>
									{editor.files.map((file) => (
										<option key={artifactKey(file)} value={artifactKey(file)}>
											{file.versionLabel} · {file.fileName} ·{" "}
											{formatBytes(file.sizeBytes)}
										</option>
									))}
								</Select>
							</ModelField>
						) : null}
						<ModelField label="ComfyUI folder" htmlFor="model-path-category">
							<Select
								id="model-path-category"
								value={editor.category}
								onChange={(event) => {
									const category = event.currentTarget.value;
									onChange({
										...editor,
										category,
										pathEdited: true,
										input: {
											...editor.input,
											path: replaceModelPathCategory(
												editor.input.path,
												category,
												editor.input.artifact,
											),
										},
									});
								}}
								className="w-full"
							>
								{!isModelPathCategory(editor.category) ? (
									<option value={editor.category}>{editor.category} (existing)</option>
								) : null}
								{MODEL_PATH_CATEGORIES.map((category) => (
									<option key={category} value={category}>
										{category}
									</option>
								))}
							</Select>
						</ModelField>
						<ModelField label="Path" htmlFor="model-path">
							<Input
								id="model-path"
								placeholder="checkpoints/model.safetensors"
								value={editor.input.path}
								onChange={(event) => {
									const path = event.currentTarget.value;
									onChange({
										...editor,
										category: modelPathCategory(path, editor.category),
										pathEdited: true,
										input: { ...editor.input, path },
									});
								}}
								required
							/>
						</ModelField>
						<Switch
							label="Sync this model to the Worker"
							checked={editor.input.sync}
							className="justify-self-start"
							onChange={(event) =>
								onChange({
									...editor,
									input: { ...editor.input, sync: event.currentTarget.checked },
								})
							}
							switchPosition="left"
						/>
					</>
				) : null}
			</div>
		</AppFormDialog>
	);
}

function ModelField({
	label,
	htmlFor,
	action,
	children,
}: {
	label: string;
	htmlFor: string;
	action?: ReactNode;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<div className="grid gap-1.5">
			<div className="flex items-baseline justify-between gap-3">
				<label htmlFor={htmlFor} className="text-sm font-medium">
					{label}
				</label>
				{action}
			</div>
			{children}
		</div>
	);
}

function SupportedModelSources(): React.JSX.Element {
	return (
		<TooltipProvider delayDuration={150} disableHoverableContent>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						Supported URLs
						<CircleHelpIcon aria-hidden="true" className="size-3.5 shrink-0" />
					</button>
				</TooltipTrigger>
				<TooltipContent
					align="end"
					className="pointer-events-none w-[min(30rem,calc(100vw-2rem))] px-3 py-2"
					sideOffset={8}
				>
					<p className="mb-2 font-medium">Examples</p>
					<ul className="grid gap-2">
						{MODEL_SOURCE_EXAMPLES.map((source) => (
							<li key={source}>
								<code className="block break-all font-mono text-xs leading-relaxed">
									{source}
								</code>
							</li>
						))}
					</ul>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

function isSupportedModelSource(value: string): boolean {
	try {
		const url = new URL(normalizeModelSourceUrl(value));
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			MODEL_SOURCE_HOSTS.has(host)
		);
	} catch {
		return false;
	}
}

function suggestedModelCategory(fileName: string, fallback: string): string {
	for (const segment of fileName.replaceAll("\\", "/").split("/")) {
		if (isModelPathCategory(segment)) return segment;
	}
	return fallback;
}

function defaultModelPath(category: string, fileName: string): string {
	const name = fileName.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
	return name ? `${category}/${name}` : "";
}

function replaceModelPathCategory(
	path: string,
	category: string,
	artifact: ModelArtifact | null,
): string {
	const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
	if (segments.length >= 2) return [category, ...segments.slice(1)].join("/");
	return artifact ? defaultModelPath(category, artifact.fileName) : "";
}

function modelPathCategory(
	path: string,
	fallback: string = DEFAULT_MODEL_PATH_CATEGORY,
): string {
	const [category, fileName] = path.replaceAll("\\", "/").split("/");
	return category && fileName ? category : fallback;
}

function modelInput(model: ModelLibraryEntry): ModelLibraryInput {
	return {
		name: model.name,
		sourceUrl: model.sourceUrl,
		path: model.path,
		sync: model.sync,
		artifact: model.artifact,
	};
}

function modelLibraryStats(
	models: readonly ModelLibraryEntry[],
): ModelLibraryStatsValue {
	let sync = 0;
	let syncSizeBytes = 0;
	let unresolvedSync = 0;
	for (const model of models) {
		if (!model.sync) continue;
		sync += 1;
		if (model.artifact === null) unresolvedSync += 1;
		else syncSizeBytes += model.artifact.sizeBytes;
	}
	return { total: models.length, sync, syncSizeBytes, unresolvedSync };
}

function artifactKey(artifact: ModelArtifact): string {
	return [
		artifact.provider,
		artifact.modelId,
		artifact.versionId,
		artifact.fileId,
	].join(":");
}

function formatBytes(value: number): string {
	if (value === 0) return "0 B";
	const exponent = Math.min(
		Math.floor(Math.log(value) / Math.log(1024)),
		BYTE_UNITS.length - 1,
	);
	const amount = value / 1024 ** exponent;
	return `${BYTE_FORMATTER.format(amount)} ${BYTE_UNITS[exponent]}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "The model-library request failed.";
}
