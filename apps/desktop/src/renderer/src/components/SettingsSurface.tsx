import {
	ArrowUpRightIcon,
	BookOpenIcon,
	BoxesIcon,
	CheckIcon,
	CircleHelpIcon,
	CopyIcon,
	InfoIcon,
	LoaderCircleIcon,
	type LucideIcon,
	PlugIcon,
	RotateCwIcon,
	Settings2Icon,
	WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppFormDialog } from "@/components/AppFormDialog";
import { useConnectionSettings } from "@/components/ConnectionControl";
import { Input } from "@/components/common/input";
import { ProgressBar } from "@/components/common/progress-bar";
import { Select } from "@/components/common/select";
import { Switch } from "@/components/common/switch";
import { EditorDirectoryLocation } from "@/components/EditorDirectoryLocation";
import { Button } from "@/components/ui/button";
import { useOptimisticUpdateQueue } from "@/hooks/useOptimisticUpdateQueue";
import {
	collectDebugInfo,
	desktopPlatformLabel,
	desktopRuntimeLabel,
	releaseChannelLabel,
} from "@/lib/debug-info";
import { cn } from "@/lib/utils";
import {
	type ComfyComponent,
	type ComfyVersionCatalog,
	type ComfyVersionState,
	type ComfyVersionUpdate,
	type ConnectionResult,
	type DesktopAppInfo,
	type DesktopTheme,
	isDesktopTheme,
	type ModelProvider,
	type ModelProviderSettings,
} from "../../../shared/api";

const SETTINGS_NAV_WIDTH = 220;

function GithubIcon({ className }: { className?: string }): React.JSX.Element {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="currentColor"
			viewBox="0 0 16 16"
		>
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.7 7.7 0 0 1 8 3.47c.68 0 1.36.09 2 .26 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
		</svg>
	);
}

function DiscordIcon({ className }: { className?: string }): React.JSX.Element {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="currentColor"
			viewBox="0 0 16 16"
		>
			<path d="M13.545 2.907a13.2 13.2 0 0 0-3.257-1.011l-.14.223a12.2 12.2 0 0 0-4.573 0l.141-.223a13.2 13.2 0 0 0-3.257 1.011C.401 6.034-.158 9.124.12 12.11a13.5 13.5 0 0 0 4.02 2.034c.362-.407.69-.858.977-1.345a8.2 8.2 0 0 1-1.537-.737c.13-.095.257-.195.38-.297a9.45 9.45 0 0 0 8.15 0c.124.102.25.202.38.297a8.3 8.3 0 0 1-1.537.737c.286.487.614.938.977 1.345a13.5 13.5 0 0 0 4.02-2.034c.325-3.46-.555-6.522-2.685-9.203ZM5.695 10.185c-.96 0-1.75-.884-1.75-1.97s.772-1.97 1.75-1.97 1.768.893 1.75 1.97c0 1.086-.772 1.97-1.75 1.97m4.338 0c-.96 0-1.75-.884-1.75-1.97s.772-1.97 1.75-1.97 1.768.893 1.75 1.97c0 1.086-.772 1.97-1.75 1.97" />
		</svg>
	);
}

const SETTINGS_SECTIONS = [
	{ key: "general", label: "General", icon: Settings2Icon },
	{ key: "comfyui", label: "ComfyUI", icon: WorkflowIcon },
	{ key: "connection", label: "Connection", icon: PlugIcon },
	{ key: "modelProviders", label: "Model Providers", icon: BoxesIcon },
	{ key: "help", label: "Help", icon: CircleHelpIcon },
	{ key: "about", label: "About", icon: InfoIcon },
] as const satisfies ReadonlyArray<{ key: string; label: string; icon: LucideIcon }>;

const HELP_RESOURCES = [
	{
		label: "Docs",
		description: "Learn how to set up and use Kastard.",
		href: "https://github.com/somecatco/kastard/blob/main/docs/en/index.mdx",
		icon: BookOpenIcon,
	},
	{
		label: "GitHub",
		description: "Browse the source code and report issues.",
		href: "https://github.com/somecatco/kastard",
		icon: GithubIcon,
	},
	{
		label: "Discord",
		description: "Ask questions and join the community.",
		href: "https://discord.gg/Z9eUBVFncN",
		icon: DiscordIcon,
	},
] as const;

type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]["key"];

type SettingsSurfaceProps = {
	focusRequest: number;
	theme: DesktopTheme;
	onThemeChange: (theme: DesktopTheme) => void;
	comfyRestarting: boolean;
	comfyRuntimeBusy: boolean;
	comfyRestartResult: ConnectionResult | null;
	onRestartComfy: () => Promise<ConnectionResult>;
	onClearComfyRestartResult: () => void;
};

function SettingsSection({
	label,
	title,
	description,
	children,
}: {
	label: string;
	title?: string;
	description?: React.ReactNode;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<section className="space-y-3" aria-label={label}>
			{title !== undefined ? (
				<div>
					<h3 className="text-sm font-medium">{title}</h3>
					{description !== undefined ? (
						<p className="mt-1 select-text text-xs text-muted-foreground">
							{description}
						</p>
					) : null}
				</div>
			) : description !== undefined ? (
				<p className="select-text text-xs text-muted-foreground">{description}</p>
			) : null}
			{children}
		</section>
	);
}

function SettingsCard({ children }: { children: React.ReactNode }): React.JSX.Element {
	return (
		<div className="divide-y divide-border overflow-hidden rounded-xl border bg-card">
			{children}
		</div>
	);
}

function SettingsRow({
	title,
	labelFor,
	description,
	descriptionId,
	feedback,
	htmlFor,
	align = "center",
	children,
}: {
	title?: React.ReactNode;
	labelFor?: string;
	description?: React.ReactNode;
	descriptionId?: string;
	feedback?: React.ReactNode;
	htmlFor?: string;
	align?: "start" | "center";
	children: React.ReactNode;
}): React.JSX.Element {
	const className = cn(
		"flex min-h-12 justify-between gap-8 px-4 py-3",
		align === "start" ? "items-start" : "items-center",
	);
	const titleClassName = "block text-[13px] leading-snug";
	const content =
		title === undefined ? (
			children
		) : (
			<>
				<span className="block min-w-0 flex-1">
					{labelFor === undefined ? (
						<span className={titleClassName}>{title}</span>
					) : (
						<label className={titleClassName} htmlFor={labelFor}>
							{title}
						</label>
					)}
					{description !== undefined ? (
						<span
							id={descriptionId}
							className="mt-1 block select-text text-pretty text-xs leading-snug text-muted-foreground"
						>
							{description}
						</span>
					) : null}
					{feedback}
				</span>
				{children}
			</>
		);

	return htmlFor === undefined ? (
		<div className={className}>{content}</div>
	) : (
		<label className={className} htmlFor={htmlFor}>
			{content}
		</label>
	);
}

function SettingsFeedback({
	kind,
	live = kind !== "info",
	hidden = false,
	className,
	children,
}: {
	kind: "info" | "success" | "error";
	live?: boolean;
	hidden?: boolean;
	className?: string;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<span
			className={cn(
				"block select-text text-pretty text-xs leading-snug",
				hidden && "sr-only",
				!hidden && kind === "info" && "text-muted-foreground",
				!hidden && kind === "success" && "text-success",
				!hidden && kind === "error" && "text-destructive",
				className,
			)}
			role={live ? (kind === "error" ? "alert" : "status") : undefined}
			aria-atomic={live ? "true" : undefined}
		>
			{children}
		</span>
	);
}

export function SettingsSurface({
	focusRequest,
	theme,
	onThemeChange,
	comfyRestarting,
	comfyRuntimeBusy,
	comfyRestartResult,
	onRestartComfy,
	onClearComfyRestartResult,
}: SettingsSurfaceProps): React.JSX.Element {
	const headingRef = useRef<HTMLHeadingElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [activeSection, setActiveSection] = useState<SettingsSectionKey>("general");
	const [pendingSettingsUpdates, setPendingSettingsUpdates] = useState(0);
	const beginSettingsUpdate = useCallback(() => {
		setPendingSettingsUpdates((current) => current + 1);
	}, []);
	const endSettingsUpdate = useCallback(() => {
		setPendingSettingsUpdates((current) => Math.max(0, current - 1));
	}, []);
	const activeSectionLabel =
		SETTINGS_SECTIONS.find(({ key }) => key === activeSection)?.label ?? "General";

	// biome-ignore lint/correctness/useExhaustiveDependencies: Refocus for each native Settings menu request.
	useEffect(() => {
		const focusTimer = window.setTimeout(() => headingRef.current?.focus(), 0);
		return () => window.clearTimeout(focusTimer);
	}, [focusRequest]);

	return (
		<div
			data-testid="settings-surface"
			className="grid h-full min-h-0 flex-1 grid-cols-[var(--settings-nav-width)_minmax(0,1fr)]"
			style={
				{
					"--settings-nav-width": `${SETTINGS_NAV_WIDTH}px`,
				} as React.CSSProperties
			}
		>
			<nav
				aria-label="Settings sections"
				className="flex min-h-0 flex-col border-r bg-muted/20"
			>
				<h1
					ref={headingRef}
					tabIndex={-1}
					className="flex h-14 shrink-0 items-center px-4 text-sm font-medium"
				>
					Settings
				</h1>
				<div className="min-h-0 space-y-0.5 overflow-y-auto px-3 pb-3">
					{SETTINGS_SECTIONS.map(({ key, label, icon: SectionIcon }) => {
						const active = activeSection === key;
						const navigationLocked = pendingSettingsUpdates > 0 && !active;
						return (
							<button
								key={key}
								type="button"
								aria-current={active ? "page" : undefined}
								aria-disabled={navigationLocked ? true : undefined}
								className={cn(
									"flex h-8 w-full items-center gap-2 rounded-full px-2 text-left text-[13px]",
									active
										? "bg-accent text-accent-foreground"
										: "text-foreground/70 hover:bg-accent hover:text-accent-foreground",
								)}
								onClick={() => {
									if (active || navigationLocked) return;
									if (contentRef.current) contentRef.current.scrollTop = 0;
									setActiveSection(key);
								}}
							>
								<SectionIcon aria-hidden="true" className="size-4 shrink-0" />
								<span className="truncate">{label}</span>
							</button>
						);
					})}
				</div>
			</nav>

			<div ref={contentRef} className="min-h-0 overflow-y-auto">
				<div className="flex min-h-full w-full flex-col space-y-8 px-8 py-10">
					<h2 className="text-xl font-semibold">{activeSectionLabel}</h2>
					{activeSection === "general" ? (
						<>
							<ThemeSettings
								theme={theme}
								onThemeChange={onThemeChange}
								onUpdateStart={beginSettingsUpdate}
								onUpdateEnd={endSettingsUpdate}
							/>
							<SyncCompletionNotificationSettings
								onUpdateStart={beginSettingsUpdate}
								onUpdateEnd={endSettingsUpdate}
							/>
						</>
					) : null}
					{activeSection === "comfyui" ? (
						<ComfyVersionSettings
							restarting={comfyRestarting}
							runtimeBusy={comfyRuntimeBusy}
							restartResult={comfyRestartResult}
							onRestart={onRestartComfy}
							onClearRestartResult={onClearComfyRestartResult}
						/>
					) : null}
					{activeSection === "connection" ? (
						<ConnectionSettings
							onUpdateStart={beginSettingsUpdate}
							onUpdateEnd={endSettingsUpdate}
						/>
					) : null}
					{activeSection === "modelProviders" ? (
						<ModelProviderTokenSettings
							onUpdateStart={beginSettingsUpdate}
							onUpdateEnd={endSettingsUpdate}
						/>
					) : null}
					{activeSection === "help" ? <HelpSettings /> : null}
					{activeSection === "about" ? (
						<>
							<ApplicationInfoSettings />
							<DebugInformationSettings />
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}

export function HelpSettings(): React.JSX.Element {
	return (
		<SettingsSection
			label="Help resources"
			title="Resources"
			description="Documentation, source code, and community support."
		>
			<SettingsCard>
				{HELP_RESOURCES.map(({ label, description, href, icon: ResourceIcon }) => (
					<a
						key={label}
						href={href}
						target="_blank"
						rel="noreferrer"
						className="flex min-h-14 items-center justify-between gap-8 px-4 py-3 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
					>
						<span className="flex min-w-0 flex-1 items-center gap-3">
							<ResourceIcon className="size-5 shrink-0 text-muted-foreground" />
							<span className="min-w-0">
								<span className="block select-text text-[13px] leading-snug">
									{label}
								</span>
								<span className="mt-1 block select-text text-xs leading-snug text-muted-foreground">
									{description}
								</span>
							</span>
						</span>
						<ArrowUpRightIcon
							aria-hidden="true"
							className="size-4 shrink-0 text-muted-foreground"
						/>
					</a>
				))}
			</SettingsCard>
		</SettingsSection>
	);
}

function ConnectionSettings({
	onUpdateStart,
	onUpdateEnd,
}: {
	onUpdateStart: () => void;
	onUpdateEnd: () => void;
}): React.JSX.Element {
	const connectionSettings = useConnectionSettings();

	return (
		<SettingsSection
			label="Connection settings"
			description="Choose what Kastard does after connecting to a Worker."
		>
			<SettingsCard>
				<SettingsRow
					title="Sync after connecting"
					description={
						<>
							Prepare the Worker backend and synchronize selected models and custom
							nodes, verify them, then start Worker ComfyUI after Connect succeeds.
						</>
					}
					htmlFor="settings-sync-after-connect"
					align="start"
				>
					<Switch
						id="settings-sync-after-connect"
						className="mt-0.5"
						checked={connectionSettings.syncAfterConnect}
						onChange={(event) => {
							onUpdateStart();
							void connectionSettings
								.updateSyncAfterConnect(event.currentTarget.checked)
								.finally(onUpdateEnd);
						}}
						disabled={connectionSettings.settingsLoading}
					/>
				</SettingsRow>
				<SettingsRow
					title="Worker system metrics"
					description="Show CPU, RAM, GPU, VRAM, temperature, and disk usage in the title bar. Turning this off also stops polling the Worker."
					feedback={
						connectionSettings.systemMetricsError ? (
							<SettingsFeedback kind="error" className="mt-1">
								{connectionSettings.systemMetricsError}
							</SettingsFeedback>
						) : null
					}
					htmlFor="settings-system-metrics"
					align="start"
				>
					<Switch
						id="settings-system-metrics"
						className="mt-0.5"
						checked={connectionSettings.systemMetricsEnabled}
						onChange={(event) => {
							void connectionSettings.updateSystemMetricsEnabled(
								event.currentTarget.checked,
							);
						}}
						disabled={connectionSettings.settingsLoading}
					/>
				</SettingsRow>
				{connectionSettings.settingsError ? (
					<SettingsFeedback kind="error" className="px-4 py-3">
						{connectionSettings.settingsError}
					</SettingsFeedback>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

function ApplicationInfoSettings(): React.JSX.Element {
	const [info, setInfo] = useState<DesktopAppInfo | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void window.kastard.appInfo
			.get()
			.then((result) => {
				if (active) setInfo(result);
			})
			.catch((cause: unknown) => {
				if (active) setError(errorMessage(cause));
			});
		return () => {
			active = false;
		};
	}, []);

	const pendingValue = error ? "Unavailable" : "Loading…";
	const details = [
		{
			label: "App Version",
			description: "The Kastard version installed on this device.",
			value: info?.version ?? pendingValue,
		},
		{
			label: "Build Number",
			description: "Build number of this Kastard version.",
			value: info?.buildNumber ?? pendingValue,
		},
		{
			label: "Channel",
			description: "Release channel of this Kastard installation.",
			value: info ? releaseChannelLabel(info.channel) : pendingValue,
		},
		{
			label: "Platform",
			description: "Operating system and architecture running Kastard.",
			value: info ? desktopPlatformLabel(info.environment) : pendingValue,
		},
		{
			label: "Runtime",
			description: "Electron, Chrome, and Node.js versions used by Kastard.",
			value: info ? desktopRuntimeLabel(info.environment) : pendingValue,
		},
	];

	return (
		<SettingsSection
			label="Application information"
			title="Application"
			description="Version details for this Kastard installation."
		>
			<SettingsCard>
				{details.map(({ label, description, value }) => (
					<SettingsRow key={label} title={label} description={description}>
						<span className="select-text break-all text-right text-[13px] text-muted-foreground">
							{value}
						</span>
					</SettingsRow>
				))}
				{error ? (
					<SettingsFeedback kind="error" className="px-4 py-3">
						{error}
					</SettingsFeedback>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

type DebugInfoCopyStatus = "idle" | "copying" | "copied" | "error";

function DebugInformationSettings(): React.JSX.Element {
	const [status, setStatus] = useState<DebugInfoCopyStatus>("idle");
	const [copyError, setCopyError] = useState<string | null>(null);
	const resetTimerRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
		},
		[],
	);

	const copy = async (): Promise<void> => {
		if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
		setStatus("copying");
		setCopyError(null);
		try {
			const result = await window.kastard.debugInfo.copy(await collectDebugInfo());
			if (!result.ok) {
				setStatus("error");
				setCopyError(result.error);
				return;
			}
			setStatus("copied");
			resetTimerRef.current = window.setTimeout(() => setStatus("idle"), 2_000);
		} catch (cause) {
			setStatus("error");
			setCopyError(errorMessage(cause));
		}
	};

	const message =
		status === "copying"
			? "Collecting debug information…"
			: status === "copied"
				? "Debug information copied."
				: (copyError ??
					"Copies app, ComfyUI, and Worker environment details for bug reports.");

	return (
		<SettingsSection
			label="Diagnostic information"
			title="Diagnostics"
			description="Collect environment details without credentials or provider tokens."
		>
			<SettingsCard>
				<SettingsRow
					title="Debug Info"
					feedback={
						<SettingsFeedback
							kind={
								status === "error" ? "error" : status === "copied" ? "success" : "info"
							}
							live={status === "error" || status === "copied"}
							className="mt-1"
						>
							{message}
						</SettingsFeedback>
					}
				>
					<Button
						type="button"
						variant="outline"
						size="default"
						aria-label={
							status === "copied" ? "Copied — copy debug info" : "Copy debug info"
						}
						onClick={() => void copy()}
						disabled={status === "copying"}
					>
						{status === "copying" ? (
							<LoaderCircleIcon className="animate-spin" />
						) : status === "copied" ? (
							<CheckIcon />
						) : (
							<CopyIcon />
						)}
						{status === "copied" ? "Copied" : "Copy"}
					</Button>
				</SettingsRow>
			</SettingsCard>
		</SettingsSection>
	);
}

function SyncCompletionNotificationSettings({
	onUpdateStart,
	onUpdateEnd,
}: {
	onUpdateStart: () => void;
	onUpdateEnd: () => void;
}): React.JSX.Element {
	const [enabled, setEnabled] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { confirm: confirmEnabled, enqueue: enqueueEnabled } = useOptimisticUpdateQueue<
		"enabled",
		boolean
	>({ trackPending: false });

	useEffect(() => {
		let active = true;
		void window.kastard.syncCompletionNotification
			.getSettings()
			.then((result) => {
				if (!active) return;
				if (result.ok) {
					confirmEnabled("enabled", result.settings.enabled);
					setEnabled(result.settings.enabled);
				} else {
					confirmEnabled("enabled", false);
					setEnabled(false);
					setError(result.error);
				}
			})
			.catch((cause: unknown) => {
				if (active) {
					confirmEnabled("enabled", false);
					setEnabled(false);
					setError(errorMessage(cause));
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [confirmEnabled]);

	const updateEnabled = (nextEnabled: boolean): void => {
		const previousValue = enabled;
		setEnabled(nextEnabled);
		onUpdateStart();
		setError(null);
		const mutation = enqueueEnabled({
			key: "enabled",
			previousValue,
			formatError: errorMessage,
			save: async () => {
				const result = await window.kastard.syncCompletionNotification.updateSettings({
					enabled: nextEnabled,
				});
				return result.ok
					? { ok: true, value: result.settings.enabled, data: undefined }
					: result;
			},
			onSuccess: (_data, { confirmed, latest }) => {
				if (latest) {
					setEnabled(confirmed);
					setError(null);
				}
			},
			onError: (message, { confirmed, latest }) => {
				if (!latest) return;
				setEnabled(confirmed);
				setError(message);
			},
		});
		void mutation.finally(() => {
			onUpdateEnd();
		});
	};

	return (
		<SettingsSection
			label="Notification settings"
			title="Notifications"
			description="Choose when Kastard alerts you on this device."
		>
			<SettingsCard>
				<SettingsRow
					title="Worker setup complete"
					description={
						<>
							Show a notification and play the system sound when synchronization
							finishes and Worker ComfyUI is ready.
						</>
					}
					htmlFor="settings-sync-completion-notification"
					align="start"
				>
					<Switch
						id="settings-sync-completion-notification"
						className="mt-0.5"
						checked={enabled}
						onChange={(event) => updateEnabled(event.currentTarget.checked)}
						disabled={loading}
					/>
				</SettingsRow>
				{error ? (
					<SettingsFeedback kind="error" className="px-4 py-3">
						{error}
					</SettingsFeedback>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

const COMFY_COMPONENTS: ReadonlyArray<{
	id: ComfyComponent;
	label: string;
	description: string;
}> = [
	{
		id: "backend",
		label: "Backend",
		description:
			"The ComfyUI that supplies nodes here and that a connected Worker is synchronized to.",
	},
	{
		id: "frontend",
		label: "Frontend",
		description: "The ComfyUI interface Kastard opens.",
	},
	{
		id: "manager",
		label: "Manager",
		description: "The ComfyUI Manager Kastard uses for local and Worker custom nodes.",
	},
];

function ComfyVersionSettings({
	restarting,
	runtimeBusy,
	restartResult,
	onRestart,
	onClearRestartResult,
}: {
	restarting: boolean;
	runtimeBusy: boolean;
	restartResult: ConnectionResult | null;
	onRestart: () => Promise<ConnectionResult>;
	onClearRestartResult: () => void;
}): React.JSX.Element {
	const [state, setState] = useState<ComfyVersionState | null>(null);
	const [catalog, setCatalog] = useState<ComfyVersionCatalog | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<ComfyVersionUpdate | null>(null);
	const [switching, setSwitching] = useState(false);
	const [switchError, setSwitchError] = useState<string | null>(null);
	const controlsDisabled = loading || switching || restarting || runtimeBusy;

	useEffect(() => {
		let active = true;
		let broadcast = false;
		const unsubscribe = window.kastard.comfyVersions.onStateChange((next) => {
			broadcast = true;
			setState(next);
		});
		void Promise.all([
			window.kastard.comfyVersions.getState(),
			window.kastard.comfyVersions.getCatalog(),
		])
			.then(([stateResult, catalogResult]) => {
				if (!active) return;
				// A broadcast that landed while this was loading is the newer value.
				if (!stateResult.ok) setError(stateResult.error);
				else if (!broadcast) setState(stateResult.state);
				if (catalogResult.ok) setCatalog(catalogResult.catalog);
				else setError((current) => current ?? catalogResult.error);
			})
			.catch((cause: unknown) => {
				if (active) setError(errorMessage(cause));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	const confirmSwitch = async (): Promise<void> => {
		if (pending === null) return;
		onClearRestartResult();
		setSwitching(true);
		setSwitchError(null);
		try {
			const result = await window.kastard.comfyVersions.select(pending);
			if (!result.ok) {
				setSwitchError(result.error);
				return;
			}
			setState(result.state);
			setPending(null);
			const refreshed = await window.kastard.comfyVersions.getCatalog();
			if (refreshed.ok) setCatalog(refreshed.catalog);
		} catch (cause) {
			setSwitchError(errorMessage(cause));
		} finally {
			setSwitching(false);
		}
	};

	const pendingComponent = COMFY_COMPONENTS.find(
		(component) => component.id === pending?.component,
	);
	const pendingInstalled =
		pending !== null &&
		((pending.component === "manager" && pending.version === null) ||
			(catalog?.[pending.component] ?? []).some(
				(option) => option.version === pending.version && option.installed,
			));
	const install = state?.install ?? null;
	// Only a downloaded release is removed; the bundled one always stays available.
	const replaced =
		pending === null || pending.component === "manager"
			? null
			: (state?.selection[pending.component] ?? null);

	return (
		<SettingsSection
			label="ComfyUI settings"
			description={
				<>
					Choose which ComfyUI release Kastard runs. Versions that are not installed yet
					are downloaded when selected.
				</>
			}
		>
			{catalog?.error ? (
				<SettingsFeedback kind="info" live>
					Showing known releases only: {catalog.error}
				</SettingsFeedback>
			) : null}
			<SettingsCard>
				<SettingsRow
					title="Restart ComfyUI"
					description="Restart ComfyUI to apply newly installed custom nodes."
					feedback={
						<>
							<SettingsFeedback
								kind="success"
								hidden={restartResult?.ok !== true}
								className="mt-1"
							>
								{restartResult?.ok === true ? "ComfyUI restarted." : ""}
							</SettingsFeedback>
							<SettingsFeedback
								kind="error"
								hidden={restartResult?.ok !== false}
								className="mt-1"
							>
								{restartResult?.ok === false ? restartResult.error : ""}
							</SettingsFeedback>
						</>
					}
				>
					<Button
						type="button"
						variant="outline"
						size="default"
						onClick={() => void onRestart()}
						disabled={controlsDisabled}
					>
						{restarting ? (
							<LoaderCircleIcon className="animate-spin" />
						) : (
							<RotateCwIcon />
						)}
						{restarting ? "Restarting…" : "Restart"}
					</Button>
				</SettingsRow>
				<SettingsRow>
					<div className="min-w-0 flex-1">
						<span className="block text-[13px] leading-snug">Location</span>
						<span className="mt-1 block select-text text-pretty text-xs leading-snug text-muted-foreground">
							Kastard&apos;s local ComfyUI data folder for custom nodes, input, output,
							and user data.
						</span>
						<EditorDirectoryLocation directory="comfy" />
					</div>
				</SettingsRow>
				{COMFY_COMPONENTS.map((component) => {
					const options = catalog?.[component.id] ?? [];
					const selected =
						state === null
							? ""
							: component.id === "manager"
								? (state.selection.manager ?? "")
								: (state.selection[component.id] ?? state.bundled[component.id]);
					// Offline with no cached listing still has to show what is running.
					const listed = options.some((option) => option.version === selected);
					return (
						<SettingsRow
							key={component.id}
							title={component.label}
							labelFor={`settings-comfy-${component.id}`}
							descriptionId={`settings-comfy-${component.id}-description`}
							description={
								<>
									{component.description}
									{component.id === "frontend" && state?.recommendedFrontend ? (
										<>
											{" "}
											ComfyUI {state.selection.backend ?? state.bundled.backend} pins{" "}
											<span className="tabular-nums">{state.recommendedFrontend}</span>.
										</>
									) : null}
									{component.id === "manager" && state?.recommendedManager ? (
										<>
											{" "}
											Backend {state.selection.backend ?? state.bundled.backend} pins{" "}
											<span className="tabular-nums">{state.recommendedManager}</span>.
										</>
									) : null}
								</>
							}
						>
							<Select
								id={`settings-comfy-${component.id}`}
								aria-describedby={`settings-comfy-${component.id}-description`}
								value={selected}
								disabled={controlsDisabled}
								onChange={(event) => {
									const version = event.currentTarget.value;
									setPending({
										component: component.id,
										version:
											component.id === "manager" && version === "" ? null : version,
									});
								}}
							>
								{component.id === "manager" ? (
									<option value="">
										Follow Backend pin
										{state?.recommendedManager ? ` · ${state.recommendedManager}` : ""}
									</option>
								) : null}
								{listed || selected === "" ? null : (
									<option value={selected}>{selected} · installed</option>
								)}
								{options.map((option) => (
									<option key={option.version} value={option.version}>
										{option.version}
										{option.installed ? " · installed" : ""}
									</option>
								))}
							</Select>
						</SettingsRow>
					);
				})}
				{error ? (
					<SettingsFeedback kind="error" className="px-4 py-3">
						{error}
					</SettingsFeedback>
				) : null}
			</SettingsCard>
			<AppFormDialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPending(null);
					setSwitchError(null);
				}}
				title={`Switch ComfyUI ${pendingComponent?.label.toLowerCase() ?? ""}?`}
				description={
					pending === null
						? ""
						: [
								pending.component === "manager"
									? pending.version === null
										? `Kastard will restart ComfyUI and follow the Backend-pinned Manager${state?.recommendedManager ? ` ${state.recommendedManager}` : ""}.`
										: pendingInstalled
											? `Kastard will restart ComfyUI with Manager ${pending.version}.`
											: `Kastard will install Manager ${pending.version} from PyPI, then restart ComfyUI.`
									: pendingInstalled
										? `Kastard will restart ComfyUI on ${pending.version}.`
										: `Kastard will download ${pending.version} from GitHub, then restart ComfyUI.`,
								replaced === null ? null : `${replaced} is removed afterwards.`,
							]
								.filter((sentence) => sentence !== null)
								.join(" ")
				}
				onSubmit={(event) => {
					event.preventDefault();
					void confirmSwitch();
				}}
				submitting={switching}
				submitLabel={
					pendingInstalled
						? "Switch"
						: pending?.component === "manager"
							? "Install and switch"
							: "Download and switch"
				}
				submittingLabel={
					pendingInstalled
						? "Switching…"
						: pending?.component === "manager"
							? "Installing…"
							: "Downloading…"
				}
				error={switchError}
			>
				{install?.status === "installing" ? (
					<ProgressBar label="ComfyUI download progress" value={install.progress} />
				) : (
					<p className="text-xs text-muted-foreground">
						Running workflows in ComfyUI stop while it restarts.
					</p>
				)}
			</AppFormDialog>
		</SettingsSection>
	);
}

const DESKTOP_THEMES: ReadonlyArray<{ value: DesktopTheme; label: string }> = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

function ThemeSettings({
	theme,
	onThemeChange,
	onUpdateStart,
	onUpdateEnd,
}: {
	theme: DesktopTheme;
	onThemeChange: (theme: DesktopTheme) => void;
	onUpdateStart: () => void;
	onUpdateEnd: () => void;
}): React.JSX.Element {
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void window.kastard.theme
			.get()
			.then((result) => {
				if (!active) return;
				if (result.ok) onThemeChange(result.theme);
				else setError(result.error);
			})
			.catch((cause: unknown) => {
				if (active) setError(errorMessage(cause));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [onThemeChange]);

	const updateTheme = async (nextTheme: DesktopTheme): Promise<void> => {
		setSaving(true);
		onUpdateStart();
		setError(null);
		try {
			const result = await window.kastard.theme.update(nextTheme);
			if (result.ok) onThemeChange(result.theme);
			else setError(result.error);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
			onUpdateEnd();
		}
	};

	return (
		<SettingsSection
			label="Appearance settings"
			title="Appearance"
			description="Choose how the Kastard interface appears on this device."
		>
			<SettingsCard>
				<SettingsRow
					title="Theme"
					labelFor="settings-theme"
					description="Follow the system appearance or always use light or dark."
					descriptionId="settings-theme-description"
				>
					<Select
						id="settings-theme"
						aria-describedby="settings-theme-description"
						value={theme}
						disabled={loading || saving}
						onChange={(event) => {
							const nextTheme = event.currentTarget.value;
							if (isDesktopTheme(nextTheme)) void updateTheme(nextTheme);
						}}
					>
						{DESKTOP_THEMES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</Select>
				</SettingsRow>
				{error ? (
					<SettingsFeedback kind="error" className="px-4 py-3">
						{error}
					</SettingsFeedback>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

const MODEL_PROVIDERS = [
	{ id: "huggingface", label: "Hugging Face" },
	{ id: "civitai", label: "CivitAI" },
] as const;

type ProviderFeedback = {
	provider: ModelProvider;
	type: "success" | "error";
	message: string;
};

function ModelProviderTokenSettings({
	onUpdateStart,
	onUpdateEnd,
}: {
	onUpdateStart: () => void;
	onUpdateEnd: () => void;
}): React.JSX.Element {
	const [configured, setConfigured] = useState<ModelProviderSettings>({
		huggingface: false,
		civitai: false,
	});
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState<ModelProvider | null>(null);
	const [feedback, setFeedback] = useState<ProviderFeedback | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void window.kastard.modelProviders
			.getSettings()
			.then((result) => {
				if (!active) return;
				if (result.ok) setConfigured(result.configured);
				else setLoadError(result.error);
			})
			.catch((error: unknown) => {
				if (!active) return;
				setLoadError(errorMessage(error));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	const updateToken = async (
		provider: ModelProvider,
		token: string | null,
	): Promise<boolean> => {
		setSaving(provider);
		onUpdateStart();
		setFeedback(null);
		try {
			const result = await window.kastard.modelProviders.updateToken({
				provider,
				token,
			});
			if (!result.ok) {
				setFeedback({ provider, type: "error", message: result.error });
				return false;
			}
			setConfigured(result.configured);
			setFeedback({
				provider,
				type: "success",
				message: token === null ? "Token removed." : "Token saved.",
			});
			return true;
		} catch (error) {
			setFeedback({ provider, type: "error", message: errorMessage(error) });
			return false;
		} finally {
			setSaving(null);
			onUpdateEnd();
		}
	};

	return (
		<SettingsSection
			label="Model provider settings"
			description="Tokens are encrypted on this device and are never shown again after saving."
		>
			{loadError ? <SettingsFeedback kind="error">{loadError}</SettingsFeedback> : null}
			<SettingsCard>
				{MODEL_PROVIDERS.map((provider) => {
					const status = loading
						? "Loading…"
						: loadError
							? "Unavailable"
							: configured[provider.id]
								? "Configured"
								: "Not configured";
					return (
						<ModelProviderTokenRow
							key={provider.id}
							provider={provider}
							configured={configured[provider.id]}
							status={status}
							busy={loading || saving !== null || loadError !== null}
							saving={saving === provider.id}
							feedback={feedback?.provider === provider.id ? feedback : null}
							onUpdate={updateToken}
							onClearFeedback={() =>
								setFeedback((current) =>
									current?.provider === provider.id ? null : current,
								)
							}
						/>
					);
				})}
			</SettingsCard>
		</SettingsSection>
	);
}

function ModelProviderTokenRow({
	provider,
	configured,
	status,
	busy,
	saving,
	feedback,
	onUpdate,
	onClearFeedback,
}: {
	provider: (typeof MODEL_PROVIDERS)[number];
	configured: boolean;
	status: string;
	busy: boolean;
	saving: boolean;
	feedback: ProviderFeedback | null;
	onUpdate: (provider: ModelProvider, token: string | null) => Promise<boolean>;
	onClearFeedback: () => void;
}): React.JSX.Element {
	const [token, setToken] = useState("");
	const [editing, setEditing] = useState(false);
	const [focusTarget, setFocusTarget] = useState<"input" | "edit" | "remove" | null>(
		null,
	);
	const inputRef = useRef<HTMLInputElement>(null);
	const editButtonRef = useRef<HTMLButtonElement>(null);
	const removeButtonRef = useRef<HTMLButtonElement>(null);
	const showEditor = !configured || editing;

	useLayoutEffect(() => {
		if (!focusTarget) return;
		const target =
			focusTarget === "input"
				? inputRef.current
				: focusTarget === "edit"
					? editButtonRef.current
					: removeButtonRef.current;
		target?.focus();
		setFocusTarget(null);
	}, [focusTarget]);

	return (
		<form
			className="px-4 py-4"
			onSubmit={(event) => {
				event.preventDefault();
				void onUpdate(provider.id, token).then((saved) => {
					if (!saved) {
						setFocusTarget("input");
						return;
					}
					setToken("");
					setEditing(false);
					setFocusTarget("edit");
				});
			}}
		>
			<div className="flex items-center justify-between gap-4">
				{showEditor ? (
					<label className="text-[13px] font-medium" htmlFor={`${provider.id}-token`}>
						{provider.label} token
					</label>
				) : (
					<span className="text-[13px] font-medium">{provider.label} token</span>
				)}
				<span className="select-text text-xs text-muted-foreground">{status}</span>
			</div>
			<div className="mt-3 flex items-center gap-2">
				{showEditor ? (
					<>
						<Input
							ref={inputRef}
							id={`${provider.id}-token`}
							type="password"
							value={token}
							onChange={(event) => setToken(event.currentTarget.value)}
							placeholder={configured ? "Enter a new token" : "Enter token"}
							autoComplete="off"
							disabled={busy}
						/>
						<Button
							type="submit"
							variant="outline"
							size="default"
							aria-label={`Save ${provider.label} token`}
							disabled={busy || token.trim().length === 0}
						>
							{saving ? <LoaderCircleIcon className="animate-spin" /> : null}
							Save
						</Button>
						{configured ? (
							<Button
								type="button"
								variant="ghost"
								size="default"
								aria-label={`Cancel editing ${provider.label} token`}
								onClick={() => {
									setToken("");
									setEditing(false);
									onClearFeedback();
									setFocusTarget("edit");
								}}
								disabled={busy}
							>
								Cancel
							</Button>
						) : null}
					</>
				) : (
					<>
						<Button
							ref={editButtonRef}
							type="button"
							variant="outline"
							size="default"
							aria-label={`Edit ${provider.label} token`}
							onClick={() => {
								onClearFeedback();
								setEditing(true);
								setFocusTarget("input");
							}}
							disabled={busy}
						>
							Edit
						</Button>
						<Button
							ref={removeButtonRef}
							type="button"
							variant="ghost"
							size="default"
							aria-label={`Remove ${provider.label} token`}
							onClick={() =>
								void onUpdate(provider.id, null).then((removed) => {
									setFocusTarget(removed ? "input" : "remove");
								})
							}
							disabled={busy}
						>
							Remove
						</Button>
					</>
				)}
			</div>
			{feedback ? (
				<SettingsFeedback kind={feedback.type} className="mt-2">
					{feedback.message}
				</SettingsFeedback>
			) : null}
		</form>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
