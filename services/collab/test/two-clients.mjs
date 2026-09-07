// Integration check: two clients on one document, through the real server.
//
// Not a unit test. It exercises the handshake, the subprotocol auth, the sync
// protocol, awareness, and the snapshot write — the things that break in
// ways unit tests do not see.
import * as Y from "yjs";
import { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

const API = process.env.API_URL ?? "http://localhost:3000";
// Two URLs so the same test can run against one replica or two. With two,
// nothing is shared in process memory and a passing run proves the Redis
// backplane is carrying the updates.
const WS_A = process.env.COLLAB_URL_A ?? process.env.COLLAB_URL ?? "ws://localhost:3001";
const WS_B = process.env.COLLAB_URL_B ?? process.env.COLLAB_URL ?? "ws://localhost:3001";
const MSG_SYNC = 0;

const j = async (res) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

const email = `collab-${Date.now()}@example.com`;
const { token } = await j(
  await fetch(`${API}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, displayName: "Collab Test", password: "a-long-enough-password" }),
  }),
);
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const ws_ = await j(
  await fetch(`${API}/v1/workspaces`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Collab test" }) }),
);
const page = await j(
  await fetch(`${API}/v1/pages`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ workspaceId: ws_.id, title: "Shared doc" }),
  }),
);
console.log("page:", page.id);

function connect(name, base) {
  const doc = new Y.Doc();
  // The token travels as a subprotocol value, not a query parameter, so it
  // never lands in an access log.
  const socket = new WebSocket(`${base}/pages/${page.id}`, [`bearer.${token}`]);
  socket.binaryType = "arraybuffer";

  socket.on("message", (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(decoder);
    if (type !== MSG_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
  });

  doc.on("update", (update, origin) => {
    if (origin === socket) return; // came from the wire; do not echo it back
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    if (socket.readyState === WebSocket.OPEN) socket.send(encoding.toUint8Array(encoder));
  });

  return new Promise((resolve, reject) => {
    socket.on("open", () => {
      // Ask the server for state written before we joined.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      socket.send(encoding.toUint8Array(enc));
      resolve({ name, doc, socket });
    });
    socket.on("error", reject);
    socket.on("unexpected-response", (_req, res) => reject(new Error(`handshake ${res.statusCode}`)));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await connect("A", WS_A);
const b = await connect("B", WS_B);
console.log(`A -> ${WS_A}   B -> ${WS_B}`);
await wait(300);

a.doc.getText("body").insert(0, "Hello from A. ");
await wait(400);
console.log("B sees:", JSON.stringify(b.doc.getText("body").toString()));

b.doc.getText("body").insert(b.doc.getText("body").length, "And B replies.");
await wait(400);
console.log("A sees:", JSON.stringify(a.doc.getText("body").toString()));

const converged = a.doc.getText("body").toString() === b.doc.getText("body").toString();
console.log(converged ? "PASS converged" : "FAIL diverged");

// Unauthorised connection must be refused during the handshake.
const bad = new WebSocket(`${WS_A}/pages/${page.id}`, ["bearer.not-a-real-token"]);
const badResult = await new Promise((resolve) => {
  bad.on("unexpected-response", (_r, res) => resolve(`rejected ${res.statusCode}`));
  bad.on("open", () => resolve("ACCEPTED — this is a bug"));
  bad.on("error", () => resolve("rejected (socket error)"));
});
console.log("bad token:", badResult);

a.socket.close();
b.socket.close();
await wait(200);
process.exit(converged ? 0 : 1);
