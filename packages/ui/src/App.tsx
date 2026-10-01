import type { DesktopBridge, DesktopState, UpdateStatus } from "@factory/protocol";
import { type FormEvent, useId, useState } from "react";
import { getBridge, useDesktopState } from "./bridge.js";
import { Workspace } from "./workspace/Workspace.js";

export function App() {
  const bridge = getBridge();
  if (!bridge) {
    return (
      <main className="center">
        <h1>The Factory</h1>
        <p className="muted">Open this in The Factory desktop app.</p>
      </main>
    );
  }
  return <Shell bridge={bridge} />;
}

function Shell({ bridge }: { bridge: DesktopBridge }) {
  const state = useDesktopState(bridge);
  if (!state) return null;

  if (state.me && state.clientConfig && !state.updateRequired) {
    return (
      <div className="app">
        <UpdateBanner update={state.update} bridge={bridge} />
        <Workspace bridge={bridge} state={state} />
      </div>
    );
  }

  let body: React.ReactNode;
  if (state.updateRequired) body = <UpdateRequired state={state} bridge={bridge} />;
  else if (!state.serverUrl || !state.clientConfig)
    body = <Connect state={state} bridge={bridge} />;
  else body = <SignIn state={state} bridge={bridge} />;

  return (
    <div className="app">
      <UpdateBanner update={state.update} bridge={bridge} />
      <main className="center">
        <h1>The Factory</h1>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {body}
      </main>
      <footer className="muted">
        v{state.appVersion} · {state.channel}
        {state.clientConfig && ` · server v${state.clientConfig.serverVersion}`}
      </footer>
    </div>
  );
}

type ScreenProps = { state: DesktopState; bridge: DesktopBridge };

function Connect({ state, bridge }: ScreenProps) {
  const [url, setUrl] = useState(state.serverUrl ?? "https://");
  const inputId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void bridge.connect(url.trim());
  };
  return (
    <form onSubmit={submit} className="stack">
      <label htmlFor={inputId}>Server address</label>
      <input id={inputId} value={url} onChange={(e) => setUrl(e.target.value)} />
      <button type="submit" disabled={state.busy}>
        {state.busy ? "Connecting…" : "Connect"}
      </button>
    </form>
  );
}

function SignIn({ state, bridge }: ScreenProps) {
  const [devToken, setDevToken] = useState("");
  const isDev = state.clientConfig?.auth.mode === "dev";
  const tokenId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void bridge.signIn(isDev ? devToken : undefined);
  };
  return (
    <form onSubmit={submit} className="stack">
      <p className="muted">Connected to {state.serverUrl}</p>
      {isDev && (
        <>
          <label htmlFor={tokenId}>Dev token</label>
          <input
            id={tokenId}
            type="password"
            value={devToken}
            onChange={(e) => setDevToken(e.target.value)}
          />
        </>
      )}
      <button type="submit" disabled={state.busy}>
        {state.busy ? "Waiting for sign-in…" : isDev ? "Sign in" : "Sign in with company account"}
      </button>
      <button type="button" className="link" onClick={() => void bridge.disconnect()}>
        Use a different server
      </button>
    </form>
  );
}

function UpdateRequired({ state, bridge }: ScreenProps) {
  return (
    <div className="stack">
      <p>
        This version is no longer supported by the server (minimum v
        {state.updateRequired?.minClientVersion}).
      </p>
      {state.update.state === "ready" ? (
        <button type="button" onClick={() => void bridge.installUpdate()}>
          Restart to update
        </button>
      ) : (
        <p className="muted">Downloading the update…</p>
      )}
    </div>
  );
}

function UpdateBanner({ update, bridge }: { update: UpdateStatus; bridge: DesktopBridge }) {
  if (update.state === "downloading") {
    return (
      <div className="banner">
        Downloading v{update.version}… {Math.round(update.percent)}%
      </div>
    );
  }
  if (update.state === "ready") {
    return (
      <div className="banner">
        v{update.version} is ready.{" "}
        <button type="button" className="link" onClick={() => void bridge.installUpdate()}>
          Restart to update
        </button>
      </div>
    );
  }
  return null;
}
