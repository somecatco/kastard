import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Popover, PopoverContent } from "@/components/common/popover";
import { PopoverTrigger } from "@/components/ui/popover";

afterEach(cleanup);

test("keeps inside interactions open and dismisses outside without consuming the click", async () => {
	const outsideClick = vi.fn();
	render(<Fixture onOutsideClick={outsideClick} />);

	fireEvent.click(screen.getByRole("button", { name: "Open details" }));
	const popover = await screen.findByRole("dialog", { name: "Details" });
	fireEvent.pointerDown(screen.getByRole("button", { name: "Inside action" }), {
		pointerType: "mouse",
	});
	expect(popover).toBeVisible();

	const outside = screen.getByRole("button", { name: "Outside action" });
	fireEvent.pointerDown(outside, { pointerType: "mouse" });
	fireEvent.click(outside);
	await waitFor(() => expect(popover).not.toBeInTheDocument());
	expect(outsideClick).toHaveBeenCalledOnce();
});

test("closes on window blur without restoring focus to the trigger", async () => {
	render(<Fixture onOutsideClick={() => undefined} />);

	const trigger = screen.getByRole("button", { name: "Open details" });
	trigger.focus();
	fireEvent.click(trigger);
	const inside = await screen.findByRole("button", { name: "Inside action" });
	inside.focus();
	expect(inside).toHaveFocus();

	fireEvent(window, new Event("blur"));
	await waitFor(() =>
		expect(screen.queryByRole("dialog", { name: "Details" })).not.toBeInTheDocument(),
	);
	expect(trigger).not.toHaveFocus();
});

function Fixture({
	onOutsideClick,
}: {
	onOutsideClick: () => void;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button type="button">Open details</button>
				</PopoverTrigger>
				<PopoverContent aria-label="Details">
					<button type="button">Inside action</button>
				</PopoverContent>
			</Popover>
			<button type="button" onClick={onOutsideClick}>
				Outside action
			</button>
		</>
	);
}
