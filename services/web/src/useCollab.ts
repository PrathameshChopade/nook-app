import { useEffect, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { getToken } from "./api";

export type ConnectionState = "idle" | "connecting" | "connected" | "disconnected";

const COLOURS = ["#0B6B5C", "#9A5A07", "#3B5BA5", "#7A3E8F", "#A63D40", "#2F6B34"];

/**
 * Opens one collaborative session for a page.
 *
 * The token travels as a WebSocket subprotocol rather than a query parameter,
 * matching what the server expects. A URL carrying a bearer token ends up in
 * access logs and Referer headers; a subprotocol value travels as a header.
 */
export function useCollab(pageId: string | null, displayName: string) {
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  // Starts idle, not connecting: with no page selected there is no socket,
  // and reporting "connecting" for something that will never connect is a
  // status line that lies.
  const [state, setState] = useState<ConnectionState>("idle");
  const [peers, setPeers] = useState(0);

  useEffect(() => {
    if (!pageId) {
      setState("idle");
      return;
    }
    setState("connecting");
    const token = getToken();
    if (!token) return;

    const ydoc = new Y.Doc();
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;

    const wsProvider = new WebsocketProvider(url, `pages/${pageId}`, ydoc, {
      protocols: [`bearer.${token}`],
      // y-websocket reconnects with exponential backoff by default. That is
      // exactly what stage 04 depends on: a rolling update closes every socket
      // with 4503, and the clients come back spread over a few seconds rather
      // than stampeding the new pods all at once.
      maxBackoffTime: 10_000,
    });

    wsProvider.awareness.setLocalStateField("user", {
      name: displayName,
      color: COLOURS[Math.floor(Math.random() * COLOURS.length)]!,
    });

    const onStatus = ({ status }: { status: string }) =>
      setState(status === "connected" ? "connected" : "disconnected");
    const onAwareness = () => setPeers(wsProvider.awareness.getStates().size);

    wsProvider.on("status", onStatus);
    wsProvider.awareness.on("change", onAwareness);

    setDoc(ydoc);
    setProvider(wsProvider);

    return () => {
      wsProvider.off("status", onStatus);
      wsProvider.awareness.off("change", onAwareness);
      wsProvider.destroy();
      ydoc.destroy();
      setDoc(null);
      setProvider(null);
    };
  }, [pageId, displayName]);

  return { doc, provider, state, peers };
}
