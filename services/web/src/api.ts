// One place that knows how to talk to the API.
//
// The token lives in memory and in sessionStorage, never in a cookie. That is
// the decision from ADR-0002 showing up on the client: a cookie would make the
// API browser-only and drag in CSRF handling that a mobile client cannot use.
const TOKEN_KEY = "nook.token";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing; the in-memory token still works for this tab */
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/v1${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message ?? `Request failed: ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export type Workspace = { id: string; name: string; ownerId: string; createdAt: string };
export type Page = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  position: number;
};

export const api = {
  register: (email: string, displayName: string, password: string) =>
    request<{ token: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, displayName, password }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<{ id: string; email: string; displayName: string }>("/auth/me"),
  workspaces: () => request<Workspace[]>("/workspaces"),
  createWorkspace: (name: string) =>
    request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  pages: (workspaceId: string) => request<Page[]>(`/workspaces/${workspaceId}/pages`),
  createPage: (workspaceId: string, title: string) =>
    request<Page>("/pages", { method: "POST", body: JSON.stringify({ workspaceId, title }) }),
  requestExport: (pageId: string) =>
    request<{ id: string }>(`/pages/${pageId}/exports`, {
      method: "POST",
      body: JSON.stringify({ format: "markdown" }),
    }),
  getExport: (id: string) =>
    request<{ status: string; downloadUrl: string | null; error: string | null }>(`/exports/${id}`),
};
