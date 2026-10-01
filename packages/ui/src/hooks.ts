import type { DesktopBridge } from "@factory/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads data and exposes reload(). Reloads from scratch whenever `key` changes
 * (e.g. the id being shown); keeps the previous value during plain reloads.
 */
export function useResource<T>(load: (() => Promise<T>) | null, key: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const fn = loadRef.current;
    if (!fn) return;
    const mine = ++generation.current;
    try {
      const value = await fn();
      if (mine === generation.current) {
        setData(value);
        setError(null);
      }
    } catch (err) {
      if (mine === generation.current) setError(errorMessage(err));
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies what to load
  useEffect(() => {
    setData(null);
    void reload();
  }, [key, reload]);

  return { data, error, reload, setData };
}

/** Subscribes to a server-sent-event stream for as long as the component is mounted. */
export function useStream(
  bridge: DesktopBridge,
  path: string | null,
  onEvent: (data: unknown) => void,
) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!path) return;
    let id: string | null = null;
    let closed = false;
    const off = bridge.onStreamEvent((streamId, data) => {
      if (streamId === id) handler.current(data);
    });
    void bridge.openStream(path).then((streamId) => {
      if (closed) void bridge.closeStream(streamId);
      else id = streamId;
    });
    return () => {
      closed = true;
      off();
      if (id) void bridge.closeStream(id);
    };
  }, [bridge, path]);
}

export function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Electron prefixes errors crossing IPC; show only the useful part.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
