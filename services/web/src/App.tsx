import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, type Page, type Workspace } from "./api";
import { useCollab } from "./useCollab";
import { Editor } from "./Editor";

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [name, setName] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<string | null>(null);

  const { doc, provider, state, peers } = useCollab(pageId, name || "Anonymous");

  useEffect(() => {
    if (!authed) return;
    api
      .me()
      .then((u) => setName(u.displayName))
      .catch(() => {
        // A token that no longer works is worse than no token: every request
        // fails in a way that looks like the server is broken.
        setToken(null);
        setAuthed(false);
      });
    api.workspaces().then(setWorkspaces).catch((e) => setError(e.message));
  }, [authed]);

  useEffect(() => {
    if (!workspaceId) return;
    api.pages(workspaceId).then(setPages).catch((e) => setError(e.message));
  }, [workspaceId]);

  const onExport = useCallback(async () => {
    if (!pageId) return;
    setExportState("queued…");
    try {
      const { id } = await api.requestExport(pageId);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const rec = await api.getExport(id);
        setExportState(rec.status);
        if (rec.status === "done" && rec.downloadUrl) {
          window.open(rec.downloadUrl, "_blank", "noopener");
          return;
        }
        if (rec.status === "failed") {
          setExportState(`failed: ${rec.error ?? "unknown"}`);
          return;
        }
      }
      setExportState("still running — check back");
    } catch (e) {
      setExportState((e as Error).message);
    }
  }, [pageId]);

  if (!authed) return <Auth onDone={() => setAuthed(true)} />;

  return (
    <div className="app">
      <aside>
        <div className="brand">Nook</div>

        <label>Workspace</label>
        <select value={workspaceId ?? ""} onChange={(e) => setWorkspaceId(e.target.value || null)}>
          <option value="">Choose…</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <button
          onClick={async () => {
            const w = await api.createWorkspace(`Workspace ${workspaces.length + 1}`);
            setWorkspaces((prev) => [...prev, w]);
            setWorkspaceId(w.id);
          }}
        >
          New workspace
        </button>

        {workspaceId && (
          <>
            <label>Pages</label>
            <ul className="pages">
              {pages.map((p) => (
                <li key={p.id}>
                  <button
                    className={p.id === pageId ? "active" : ""}
                    onClick={() => setPageId(p.id)}
                  >
                    {p.title}
                  </button>
                </li>
              ))}
            </ul>
            <button
              onClick={async () => {
                const p = await api.createPage(workspaceId, `Page ${pages.length + 1}`);
                setPages((prev) => [...prev, p]);
                setPageId(p.id);
              }}
            >
              New page
            </button>
          </>
        )}

        <div className="spacer" />
        <button
          onClick={() => {
            setToken(null);
            setAuthed(false);
          }}
        >
          Sign out
        </button>
      </aside>

      <main>
        <header>
          <span className={`dot ${state}`} />
          <span className="status">
            {state}
            {state === "connected" && peers > 0 ? ` · ${peers} here` : ""}
          </span>
          {pageId && <button onClick={onExport}>Export Markdown</button>}
          {exportState && <span className="export">{exportState}</span>}
        </header>

        {error && <p className="error">{error}</p>}

        {doc && provider ? (
          <Editor doc={doc} provider={provider} name={name || "Anonymous"} />
        ) : (
          <p className="empty">Pick a page, or create one.</p>
        )}
      </main>
    </div>
  );
}

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } =
        mode === "register"
          ? await api.register(email, displayName, password)
          : await api.login(email, password);
      setToken(token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth" onSubmit={submit}>
      <h1>Nook</h1>
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      {mode === "register" && (
        <input
          placeholder="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      )}
      <input
        type="password"
        placeholder="Password (12 characters or more)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? "…" : mode === "register" ? "Create account" : "Sign in"}</button>
      <button type="button" className="link" onClick={() => setMode(mode === "register" ? "login" : "register")}>
        {mode === "register" ? "I already have an account" : "Create an account instead"}
      </button>
    </form>
  );
}
