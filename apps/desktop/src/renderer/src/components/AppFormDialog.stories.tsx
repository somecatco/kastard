import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AppFormDialog } from "@/components/AppFormDialog";
import { Input } from "@/components/common/input";
import { Button } from "@/components/ui/button";

type FormDialogKind = "form" | "confirmation" | "destructive";

type FormDialogStoryProps = {
	kind: FormDialogKind;
};

const dialogCopy: Record<
	FormDialogKind,
	{
		title: string;
		description: string;
		submitLabel: string;
		submitVariant?: "default" | "destructive";
	}
> = {
	form: {
		title: "Add Model",
		description: "Enter a Hugging Face or CivitAI model URL.",
		submitLabel: "Load Model Info",
	},
	confirmation: {
		title: "Switch ComfyUI backend?",
		description:
			"Kastard will download v0.34.0 from GitHub, then restart ComfyUI. v0.33.1 is removed afterwards.",
		submitLabel: "Download and switch",
	},
	destructive: {
		title: "Delete model?",
		description:
			"Remove FLUX.1-dev from the Model Library? This does not delete a downloaded model file.",
		submitLabel: "Delete",
		submitVariant: "destructive",
	},
};

function DialogBody({ kind }: FormDialogStoryProps): React.JSX.Element | null {
	if (kind === "form") {
		return (
			<label
				htmlFor="story-model-source-url"
				className="grid gap-1.5 text-sm font-medium"
			>
				Source URL
				<Input
					id="story-model-source-url"
					placeholder="Paste a model URL"
					defaultValue="https://huggingface.co/black-forest-labs/FLUX.1-dev"
				/>
			</label>
		);
	}

	return kind === "confirmation" ? (
		<p className="cursor-text select-text text-xs text-muted-foreground">
			Running workflows in ComfyUI stop while it restarts.
		</p>
	) : null;
}

function FormDialogStory({ kind }: FormDialogStoryProps): React.JSX.Element {
	const [open, setOpen] = useState(true);
	const copy = dialogCopy[kind];

	return (
		<div className="flex min-h-svh items-center justify-center bg-[#090a0b] p-6">
			<Button type="button" variant="secondary" onClick={() => setOpen(true)}>
				Open dialog
			</Button>
			<AppFormDialog
				open={open}
				onOpenChange={setOpen}
				title={copy.title}
				description={copy.description}
				onSubmit={(event) => event.preventDefault()}
				submitting={false}
				submitLabel={copy.submitLabel}
				submittingLabel={`${copy.submitLabel}…`}
				submitVariant={copy.submitVariant}
			>
				<DialogBody kind={kind} />
			</AppFormDialog>
		</div>
	);
}

const meta = {
	title: "Desktop/Form Dialog",
	component: FormDialogStory,
	parameters: {
		layout: "fullscreen",
	},
	args: {
		kind: "form",
	},
} satisfies Meta<typeof FormDialogStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Form: Story = {};

export const Confirmation: Story = {
	args: { kind: "confirmation" },
};

export const Destructive: Story = {
	args: { kind: "destructive" },
};
