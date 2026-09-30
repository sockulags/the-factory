import type { DesktopBridge, DesktopState } from "@factory/protocol";
import { useEffect, useState } from "react";

declare global {
  interface Window {
    factory?: DesktopBridge;
  }
}

export function getBridge(): DesktopBridge | null {
  return window.factory ?? null;
}

export function useDesktopState(bridge: DesktopBridge): DesktopState | null {
  const [state, setState] = useState<DesktopState | null>(null);
  useEffect(() => {
    let active = true;
    void bridge.getState().then((s) => active && setState(s));
    const unsubscribe = bridge.onStateChange(setState);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);
  return state;
}
