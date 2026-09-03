import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Switch } from "@/components/common/switch";

test("renders a switch with visible text", () => {
	const onChange = vi.fn();
	render(
		<Switch label="Sync" aria-label="Sync custom node" checked onChange={onChange} />,
	);

	const control = screen.getByRole("switch", { name: "Sync custom node" });
	const label = screen.getByText("Sync").closest("label");
	expect(label).toBeVisible();
	expect(label).toHaveClass("cursor-default");
	expect(control).toBeChecked();
	expect(control).toHaveAttribute("aria-checked", "true");

	fireEvent.click(control);
	expect(onChange).toHaveBeenCalledOnce();
});

test("renders an accessible switch without visible text", () => {
	render(<Switch aria-label="Worker setup complete" checked={false} readOnly />);

	const control = screen.getByRole("switch", { name: "Worker setup complete" });
	expect(control).not.toBeChecked();
	expect(control).toHaveAttribute("aria-checked", "false");
	expect(screen.queryByText("Worker setup complete")).not.toBeInTheDocument();
});

test("renders the switch before its visible label", () => {
	render(<Switch checked={false} label="Sync" switchPosition="left" readOnly />);

	const control = screen.getByRole("switch", { name: "Sync" });
	const label = control.closest("label");
	expect(label?.firstElementChild).toContainElement(control);
});
