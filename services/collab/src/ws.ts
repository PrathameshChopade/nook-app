import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";

import { logger } from "./logger.js";
import { activeConnections, connectionAttempts } from "./metrics.js";
import { tokenFromHandshake, verifyToken, accessToPage } from "./auth.js";
import { getDoc, releaseDoc } from "./docs.js";
import { encodeSyncStep1, encodeError, handleIncoming } from "./protocol.js";

// Close codes. 4000-4999 is the range reserved for application use; the client
// distinguishes "reconnect, this was us" from "stop, you are not allowed".
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_GOING_AWAY = 4503; // deploying; reconnect with backoff

const PAGE_PATH = /^\/pages\/([0-9a-f-]{36})\/?$/i;

export function attachWebSocketServer(server: import("node:http").Server): WebSocketServer {
  // noServer: we do the upgrade ourselves so authentication happens before a
  // WebSocket exists at all. Rejecting during the handshake means an
  // unauthorised client never gets an open socket to send anything on.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    void (async () => {
      const reject = (code: number, outcome: string, body: string) => {
        connectionAttempts.inc({ outcome });
        socket.write(`HTTP/1.1 ${code} ${body}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };

      const match = PAGE_PATH.exec(new URL(req.url ?? "/", "http://localhost").pathname);
      if (!match?.[1]) return reject(400, "bad_request", "Bad Request");
      const pageId = match[1];

      const token = tokenFromHandshake(req.headers["sec-websocket-protocol"]);
      if (!token) return reject(401, "unauthorized", "Unauthorized");

      const claims = verifyToken(token);
      if (!claims) return reject(401, "unauthorized", "Unauthorized");

      const access = await accessToPage(claims.sub, pageId);
      if (!access) return reject(403, "forbidden", "Forbidden");

      // Echo back the subprotocol we accepted, or the browser closes the
      // connection immediately for having negotiated nothing.
      wss.handleUpgrade(req, socket, head, (ws) => {
        connectionAttempts.inc({ outcome: "accepted" });
        void onConnection(ws, pageId, claims.sub, access.canEdit);
      });
    })().catch((err) => {
      connectionAttempts.inc({ outcome: "error" });
      logger.error({ err }, "upgrade failed");
      socket.destroy();
    });
  });

  return wss;
}

async function onConnection(ws: WebSocket, pageId: string, userId: string, canEdit: boolean) {
  const doc = await getDoc(pageId);
  const peer = { send: (data: Uint8Array) => ws.readyState === WebSocket.OPEN && ws.send(data) };

  doc.sockets.add(peer);
  activeConnections.inc();
  const log = logger.child({ pageId, userId, canEdit });
  log.info("client connected");

  // The server speaks first with sync step 1, which asks the client for
  // anything we are missing. The client must send its own step 1 to receive
  // what *it* is missing — see the sequence in protocol.ts. Sending ours
  // immediately saves a round trip on the client-to-server half.
  peer.send(encodeSyncStep1(doc.ydoc));

  // Liveness at the socket layer. A client that dies without closing cleanly —
  // a laptop lid, a dropped network — leaves a socket that looks open forever
  // and keeps its cursor on screen for everyone else. TCP will not tell us.
  // Which awareness client ids this socket owns. Awareness carries no record
  // of which connection introduced a state, so if we do not track it here
  // there is no way to clean up exactly this user's cursor on disconnect.
  const controlledIds = new Set<number>();
  const trackAwareness = ({ added, updated }: any, origin: unknown) => {
    if (origin !== peer) return;
    for (const id of [...added, ...updated]) controlledIds.add(id);
  };
  doc.awareness.on("update", trackAwareness);

  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      log.info("client failed heartbeat, terminating");
      return ws.terminate();
    }
    alive = false;
    ws.ping();
  }, 30_000);

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return; // the protocol is binary; text frames are a bug
    try {
      const result = handleIncoming(new Uint8Array(data), doc.ydoc, doc.awareness, peer, !canEdit);
      if (result.type === "sync" && result.reply) peer.send(result.reply);
      else if (result.type === "awareness") {
        // Awareness is presence, not content: a viewer's cursor is allowed
        // even though their edits are not. Applying it with `peer` as origin
        // keeps it from being echoed straight back to the sender.
        applyAwarenessUpdate(doc.awareness, result.payload, peer);
      }
    } catch (err) {
      log.warn({ err }, "malformed frame");
      peer.send(encodeError("malformed frame"));
      ws.close(CLOSE_BAD_REQUEST, "malformed frame");
    }
  });

  ws.on("close", (code) => {
    clearInterval(heartbeat);
    doc.sockets.delete(peer);
    activeConnections.dec();

    // Remove this client's cursor for everyone else. Without it, a
    // disconnected user's caret stays on the page indefinitely.
    doc.awareness.off("update", trackAwareness);
    if (controlledIds.size > 0) removeAwarenessStates(doc.awareness, [...controlledIds], null);

    log.info({ code }, "client disconnected");
    releaseDoc(doc);
  });

  ws.on("error", (err) => log.warn({ err }, "socket error"));
}
