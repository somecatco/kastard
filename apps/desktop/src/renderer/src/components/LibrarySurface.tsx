import {
	AlertTriangleIcon,
	InfoIcon,
	LoaderCircleIcon,
	type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { EditorDirectoryLocation } from "@/components/EditorDirectoryLocation";
import type { EditorDirectory } from "../../../shared/api";

type LibrarySurfaceSummary = {
	label: string;
	items: ReadonlyArray<{
		label: string;
		value: ReactNode;
	}>;
};

type LibrarySurfaceEmptyState = {
	icon: LucideIcon;
	title: string;
	description: string;
};

export function LibrarySurface({
	title,
	description,
	action,
	directory,
	summary,
	error,
	notice,
	loadingLabel,
	emptyState,
	children,
}: {
	title: string;
	description: string;
	action?: ReactNode;
	directory: Exclude<EditorDirectory, "comfy">;
	summary: LibrarySurfaceSummary | null;
	error: string | null;
	notice?: string | null;
	loadingLabel: string | null;
	emptyState: LibrarySurfaceEmptyState | null;
	children?: ReactNode;
}): React.JSX.Element {
	const titleId = `${directory}-title`;
	const EmptyIcon = emptyState?.icon;

	return (
		<section
			aria-labelledby={titleId}
			className="min-h-0 flex-1 overflow-y-auto bg-background px-8 py-7"
		>
			<div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
				<header>
					<div className="flex items-start justify-between gap-4">
						<div className="min-w-0 flex-1">
							<h1 id={titleId} className="text-xl font-semibold">
								{title}
							</h1>
							<p className="mt-1 text-sm text-muted-foreground">{description}</p>
						</div>
						{action}
					</div>
					<EditorDirectoryLocation directory={directory} />
					{summary !== null ? (
						<dl
							aria-label={summary.label}
							className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm"
						>
							{summary.items.map((item) => (
								<div key={item.label} className="flex items-baseline gap-1.5">
									<dt className="text-muted-foreground">{item.label}</dt>
									<dd className="font-medium tabular-nums">{item.value}</dd>
								</div>
							))}
						</dl>
					) : null}
				</header>

				{error !== null ? (
					<div
						role="alert"
						className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
					>
						<AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
						<span>{error}</span>
					</div>
				) : null}
				{notice ? (
					<div
						role="status"
						className="flex items-start gap-2 rounded-lg border bg-muted/40 px-4 py-3 text-sm"
					>
						<InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<span>{notice}</span>
					</div>
				) : null}
				{loadingLabel !== null ? (
					<div
						className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
						role="status"
					>
						<LoaderCircleIcon className="size-4 animate-spin" />
						{loadingLabel}
					</div>
				) : emptyState !== null && EmptyIcon !== undefined ? (
					<div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
						<EmptyIcon className="size-9 text-muted-foreground" />
						<h2 className="mt-3 font-medium">{emptyState.title}</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							{emptyState.description}
						</p>
					</div>
				) : children != null ? (
					<div className="overflow-hidden rounded-xl border">{children}</div>
				) : null}
			</div>
		</section>
	);
}
