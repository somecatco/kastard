import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { useCloseOnWindowBlur } from "@/hooks/useCloseOnWindowBlur";

const hoverOverlayClosers = new Set<() => void>();
const hoverOverlayListeners = new Set<() => void>();

export function closeHoverOverlays(): void {
	const closers = [...hoverOverlayClosers];
	hoverOverlayClosers.clear();
	notifyHoverOverlayListeners();
	for (const close of closers) close();
}

export function useHoverOverlayActive(): boolean {
	return useSyncExternalStore(
		(listener) => {
			hoverOverlayListeners.add(listener);
			return () => {
				hoverOverlayListeners.delete(listener);
			};
		},
		() => hoverOverlayClosers.size > 0,
	);
}

export function useCloseHoverOverlay(
	open: boolean,
	openedFromPointer: boolean,
	onClose: () => void,
): void {
	useCloseOnWindowBlur(open, onClose);
	const close = useEffectEvent(onClose);

	useEffect(() => {
		if (!open || !openedFromPointer) return;
		const closeCurrent = (): void => close();
		hoverOverlayClosers.add(closeCurrent);
		notifyHoverOverlayListeners();
		return () => {
			if (hoverOverlayClosers.delete(closeCurrent)) notifyHoverOverlayListeners();
		};
	}, [open, openedFromPointer]);
}

function notifyHoverOverlayListeners(): void {
	for (const listener of hoverOverlayListeners) listener();
}
