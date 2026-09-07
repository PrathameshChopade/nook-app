import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

/**
 * The Nook realtime protocol.
 *
 * Binary, not JSON. Every frame begins with a single-byte message type:
 *
 *   0  SYNC       a y-protocols sync message (step 1, step 2, or update)
 *   1  AWARENESS  cursor positions and presence
 *   2  ERROR      server-originated, carries a reason string; the server
 *                 closes the socket immediately after sending one
 *
 * Connection sequence, and the part that is easy to get wrong:
 *
 *   server -> client   SYNC step 1   (server's state vector)
 *   client -> server   SYNC step 2   (what the client has that the server lacks)
 *   client -> server   SYNC step 1   (client's state vector)   <- REQUIRED
 *   server -> client   SYNC step 2   (what the server has that the client lacks)
 *
 * Both directions are needed. A step 1 asks the *other side* to send what it
 * is missing, so the server's step 1 alone only moves data client -> server.
 * A client that does not send its own step 1 connects successfully, receives
 * live edits from that moment on, and never sees anything written before it
 * joined — an empty page that quietly fills in as soon as someone types.
 *
 * This is documented here rather than left implicit because a second client —
 * a mobile app, a load-test harness in stage 08 — has to be able to speak it
 * without reading the server source. ADR-0002 covers why that matters.
 */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_ERROR = 2;

export function encodeSyncStep1(ydoc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(encoder, ydoc);
  return encoding.toUint8Array(encoder);
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwarenessMessage(payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

export function encodeError(reason: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_ERROR);
  encoding.writeVarString(encoder, reason);
  return encoding.toUint8Array(encoder);
}

export type Incoming =
  | { type: "sync"; reply: Uint8Array | null }
  | { type: "awareness"; payload: Uint8Array }
  | { type: "unknown" };

/**
 * Decodes one client frame.
 *
 * `readOnly` is enforced here rather than at the edges: a viewer may send
 * sync step 1 (asking for state) but must not have their updates applied.
 * Dropping them silently is deliberate — a viewer whose client is buggy
 * should not be able to fill the logs.
 */
export function handleIncoming(
  data: Uint8Array,
  ydoc: Y.Doc,
  awareness: Awareness,
  origin: unknown,
  readOnly: boolean,
): Incoming {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);

  if (type === MSG_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, ydoc, readOnly ? null : origin);
    // length 1 means only the type byte was written: nothing to say back.
    const reply = encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
    return { type: "sync", reply };
  }

  if (type === MSG_AWARENESS) {
    return { type: "awareness", payload: decoding.readVarUint8Array(decoder) };
  }

  return { type: "unknown" };
}
