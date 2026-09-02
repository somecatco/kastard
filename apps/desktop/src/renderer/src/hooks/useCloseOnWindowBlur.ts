import { useEffectEvent, useLayoutEffect } from "react";

export function useCloseOnWindowBlur(open: boolean, onClose: () => void): void {
	const close = useEffectEvent(onClose);

	useLayoutEffect(() => {
		if (!open) return;
		window.addEventListener("blur", close);
		return () => window.removeEventListener("blur", close);
	}, [open]);
}
