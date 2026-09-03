import {
	BoxesIcon,
	CheckIcon,
	CloudCogIcon,
	ExternalLinkIcon,
	LoaderCircleIcon,
	type LucideIcon,
	ServerIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Input } from "@/components/common/input";
import { Switch } from "@/components/common/switch";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { resources, workerTemplateLinks } from "@/lib/resources";
import { cn } from "@/lib/utils";
import {
	buildWorkerServerUrl,
	connectionInputValue,
} from "@/lib/worker-connection-target";
import type {
	ConnectionRequest,
	ConnectionResult,
	WorkerProvider,
} from "../../../shared/api";

type ProviderOption = {
	id: WorkerProvider;
	label: string;
	description: string;
	icon: LucideIcon;
	iconClassName: string;
};

export type ConnectWorkerDialogProps = {
	initialProvider: WorkerProvider | null;
	initialServerUrl: string | null;
	initialSyncAfterConnect: boolean;
	defaultServerUrl?: string;
	settingsLoading?: boolean;
	onConnect: (request: ConnectionRequest) => Promise<ConnectionResult>;
	onConnected: (syncAfterConnect: boolean) => void;
	onOpenChange: (open: boolean) => void;
};

const TEMPLATE_CHANNEL = import.meta.env.MODE === "preview" ? "preview" : "production";
const ACTIVE_TEMPLATE_LINKS = {
	runpod: workerTemplateLinks.runpod[TEMPLATE_CHANNEL],
	vastai: workerTemplateLinks.vastAi[TEMPLATE_CHANNEL],
};
const TEMPLATE_LINKS = [
	{
		runtime: "cu128",
		label: "CUDA 12.8 template",
	},
	{
		runtime: "cu130",
		label: "CUDA 13.0 template",
	},
] as const;

const PROVIDERS: ProviderOption[] = [
	{
		id: "runpod",
		label: "RunPod",
		description: "Deploy a Worker with a Kastard template.",
		icon: CloudCogIcon,
		iconClassName: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
	},
	{
		id: "vastai",
		label: "Vast.ai",
		description: "Deploy a Worker with a Kastard template.",
		icon: BoxesIcon,
		iconClassName: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
	},
	{
		id: "other",
		label: "Other server",
		description: "Connect to a Worker running on another server.",
		icon: ServerIcon,
		iconClassName: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
	},
];

export function ConnectWorkerDialog({
	initialProvider,
	initialServerUrl,
	initialSyncAfterConnect,
	defaultServerUrl = "",
	settingsLoading = false,
	onConnect,
	onConnected,
	onOpenChange,
}: ConnectWorkerDialogProps): React.JSX.Element {
	const [provider, setProvider] = useState<WorkerProvider | null>(initialProvider);
	const [value, setValue] = useState(() =>
		connectionInputValue(initialProvider, initialServerUrl),
	);
	const [authenticationCode, setAuthenticationCode] = useState("");
	const [syncAfterConnect, setSyncAfterConnect] = useState(initialSyncAfterConnect);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const targetEdited = useRef(false);
	const serverUrl = provider === null ? null : buildWorkerServerUrl(provider, value);

	useEffect(() => {
		if (targetEdited.current) return;
		setProvider(initialProvider);
		setValue(connectionInputValue(initialProvider, initialServerUrl));
	}, [initialProvider, initialServerUrl]);

	useEffect(() => {
		if (!settingsLoading) setSyncAfterConnect(initialSyncAfterConnect);
	}, [initialSyncAfterConnect, settingsLoading]);

	const selectProvider = (nextProvider: WorkerProvider): void => {
		if (nextProvider === provider) return;
		targetEdited.current = true;
		setProvider(nextProvider);
		setValue(nextProvider === "other" ? defaultServerUrl : "");
		setAuthenticationCode("");
		setError(null);
	};

	const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (provider === null || serverUrl === null || authenticationCode.trim() === "") {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const result = await onConnect({
				provider,
				serverUrl,
				authenticationCode,
				syncAfterConnect,
			});
			if (result.ok) {
				onConnected(syncAfterConnect);
				onOpenChange(false);
			} else {
				setError(result.error);
			}
		} catch (connectError) {
			setError(errorMessage(connectError));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(nextOpen) => {
				if (!submitting) onOpenChange(nextOpen);
			}}
		>
			<DialogContent className="max-h-[calc(100svh-2rem)] max-w-2xl overflow-y-auto">
				<form
					className="grid gap-5"
					onSubmit={(event) => void submit(event)}
					noValidate
				>
					<DialogHeader>
						<DialogTitle>Connect to Worker</DialogTitle>
						<DialogDescription>
							Enter the address and authentication code shown in the Worker log.
						</DialogDescription>
					</DialogHeader>

					<fieldset className="grid gap-2 sm:grid-cols-3" disabled={submitting}>
						<legend className="sr-only">Worker provider</legend>
						{PROVIDERS.map((option) => {
							const selected = option.id === provider;
							const Icon = option.icon;
							return (
								<button
									key={option.id}
									type="button"
									aria-pressed={selected}
									className={cn(
										"relative rounded-xl border p-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										selected && "border-foreground/45 bg-accent shadow-sm",
									)}
									onClick={() => selectProvider(option.id)}
								>
									<span
										aria-hidden="true"
										className={cn(
											"mb-3 flex size-9 items-center justify-center rounded-lg",
											option.iconClassName,
										)}
									>
										<Icon className="size-5" />
									</span>
									<span className="block text-sm font-medium">{option.label}</span>
									<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
										{option.description}
									</span>
									{selected ? (
										<CheckIcon className="absolute right-3 top-3 size-4" />
									) : null}
								</button>
							);
						})}
					</fieldset>

					{provider === null ? (
						<div className="rounded-lg border border-dashed p-5 text-center">
							<p className="cursor-text select-text text-sm text-muted-foreground">
								Select a provider to see its setup steps.
							</p>
						</div>
					) : (
						<ProviderSetup
							provider={provider}
							value={value}
							authenticationCode={authenticationCode}
							onValueChange={(nextValue) => {
								targetEdited.current = true;
								setValue(nextValue);
								setError(null);
							}}
							onAuthenticationCodeChange={(code) => {
								setAuthenticationCode(code);
								setError(null);
							}}
							disabled={submitting}
						/>
					)}

					<label
						className="flex items-start gap-3 rounded-lg border p-4"
						htmlFor="connect-sync-after-connect"
					>
						<Switch
							id="connect-sync-after-connect"
							className="mt-0.5"
							checked={syncAfterConnect}
							onChange={(event) => setSyncAfterConnect(event.currentTarget.checked)}
							disabled={submitting || settingsLoading}
						/>
						<span className="grid gap-1">
							<span className="text-sm font-medium">Sync after connecting</span>
							<span className="cursor-text select-text text-xs leading-relaxed text-muted-foreground">
								Prepare the Worker backend, synchronize selected models and custom
								nodes, then start Worker ComfyUI.
							</span>
						</span>
					</label>

					{error !== null ? (
						<p className="select-text text-sm text-destructive" role="alert">
							{error}
						</p>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={submitting}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={
								submitting || serverUrl === null || authenticationCode.trim() === ""
							}
						>
							{submitting ? <LoaderCircleIcon className="animate-spin" /> : null}
							{submitting ? "Connecting…" : "Connect"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function SetupStep({
	number,
	title,
	description,
	children,
}: {
	number: number;
	title: string;
	description: string;
	children: ReactNode;
}): React.JSX.Element {
	return (
		<section className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
			<span
				aria-hidden="true"
				className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
			>
				{number}
			</span>
			<div className="min-w-0 pt-0.5">
				<h3 className="cursor-text select-text text-sm font-medium">{title}</h3>
				<p className="mt-1 cursor-text select-text text-xs leading-relaxed text-muted-foreground">
					{description}
				</p>
				<div className="mt-3">{children}</div>
			</div>
		</section>
	);
}

function TemplateLinks({ provider }: { provider: "runpod" | "vastai" }) {
	return (
		<div className="flex flex-wrap gap-2">
			{TEMPLATE_LINKS.map(({ runtime, label }) => (
				<Button key={label} asChild type="button" variant="outline" size="default">
					<a
						href={ACTIVE_TEMPLATE_LINKS[provider][runtime]}
						target="_blank"
						rel="noreferrer"
					>
						{label}
						<ExternalLinkIcon />
					</a>
				</Button>
			))}
		</div>
	);
}

function ProviderSetup({
	provider,
	value,
	authenticationCode,
	onValueChange,
	onAuthenticationCodeChange,
	disabled,
}: {
	provider: WorkerProvider;
	value: string;
	authenticationCode: string;
	onValueChange: (value: string) => void;
	onAuthenticationCodeChange: (value: string) => void;
	disabled: boolean;
}): React.JSX.Element {
	return (
		<div className="grid gap-5 border-t pt-5">
			<SetupStep
				number={1}
				title={
					provider === "other"
						? "Start a Worker"
						: `Deploy a ${provider === "runpod" ? "RunPod" : "Vast.ai"} Worker`
				}
				description={
					provider === "other"
						? "Start a Worker on your server."
						: "Choose the template that matches the CUDA runtime supported by your GPU."
				}
			>
				{provider === "other" ? (
					<Button asChild type="button" variant="outline" size="default">
						<a
							href={resources.docs.runWorkerWithDocker}
							target="_blank"
							rel="noreferrer"
						>
							Open setup guide
							<ExternalLinkIcon />
						</a>
					</Button>
				) : (
					<TemplateLinks provider={provider} />
				)}
			</SetupStep>
			<SetupStep
				number={2}
				title="Enter the Worker address"
				description="Copy the host and port printed as Address in the Worker log."
			>
				<label className="grid gap-2" htmlFor="worker-address">
					<span className="text-xs font-medium">Worker address</span>
					<Input
						id="worker-address"
						value={value}
						onChange={(event) => onValueChange(event.target.value)}
						placeholder="PUBLIC_IP:EXTERNAL_PORT"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						disabled={disabled}
					/>
				</label>
			</SetupStep>
			<SetupStep
				number={3}
				title="Enter the authentication code"
				description="Use the code from the Worker log. It remains valid until this Worker stops."
			>
				<label className="grid gap-2" htmlFor="worker-authentication-code">
					<span className="text-xs font-medium">Authentication code</span>
					<Input
						id="worker-authentication-code"
						value={authenticationCode}
						onChange={(event) => onAuthenticationCodeChange(event.target.value)}
						placeholder="ABCD-EFGH-JKLM-NPQR"
						autoCapitalize="characters"
						autoCorrect="off"
						spellCheck={false}
						disabled={disabled}
					/>
				</label>
			</SetupStep>
		</div>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
