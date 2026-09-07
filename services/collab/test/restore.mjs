import * as Y from "yjs";
import { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
const [pageId, token] = process.argv.slice(2);
const doc = new Y.Doc();
const s = new WebSocket(`ws://localhost:3001/pages/${pageId}`, [`bearer.${token}`]);
s.binaryType = "arraybuffer";
s.on("message", (d) => {
  const dec = decoding.createDecoder(new Uint8Array(d));
  if (decoding.readVarUint(dec) !== 0) return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.readSyncMessage(dec, enc, doc, s);
  if (encoding.length(enc) > 1) s.send(encoding.toUint8Array(enc));
});
s.on("unexpected-response", (_r, res) => { console.log("handshake rejected:", res.statusCode); process.exit(2); });
await new Promise((r) => s.on("open", r));
// Ask the server for state written before we joined. Without this the
// document stays empty until somebody types.
{
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  s.send(encoding.toUint8Array(enc));
}
await new Promise((r) => setTimeout(r, 900));
const text = doc.getText("body").toString();
console.log("restored from Postgres:", JSON.stringify(text));
process.exit(text.includes("And B replies") ? 0 : 1);
