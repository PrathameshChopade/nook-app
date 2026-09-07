import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";
import { Redis } from "ioredis";

import { encodeSyncUpdate, encodeAwarenessMessage } from "./protocol.js";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { loadSnapshot, saveSnapshot } from "./db.js";
import { loadedDocuments, snapshotWrites, syncLatency } from "./metrics.js";

// Every replica gets an identity, stamped onto everything it publishes, so it
// can ignore its own messages coming back off the fan-out. Without this a
// single edit loops: publish -> receive own message -> apply -> publish.
const REPLICA_ID = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
const KIND_UPDATE = 0;
const KIND_AWARENESS = 1;

// Marks a change as having arrived from Redis, so the update handler knows not
// to publish it back out again.
export const REMOTE_ORIGIN = Symbol("remote");

const channel = (pageId: string) => `nook:doc:${pageId}`;

export type Doc = {
  pageId: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  sockets: Set<{ send: (data: Uint8Array) => void }>;
  dirty: boolean;
  snapshotTimer?: NodeJS.Timeout | undefined;
  idleTimer?: NodeJS.Timeout | undefined;
};

const docs = new Map<string, Doc>();

// Two connections: ioredis puts a client into subscriber mode, after which it
// can no longer issue ordinary commands. Publishing therefore needs its own.
export const publisher = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
export const subscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

publisher.on("error", (err: Error) => logger.error({ err }, "redis publisher error"));
subscriber.on("error", (err: Error) => logger.error({ err }, "redis subscriber error"));

subscriber.on("messageBuffer", (chanBuf: Buffer, message: Buffer) => {
  const pageId = chanBuf.toString().slice("nook:doc:".length);
  const doc = docs.get(pageId);
  if (!doc) return;

  if (message.subarray(0, 16).equals(REPLICA_ID)) return; // our own echo

  const kind = message[16];
  const payload = new Uint8Array(message.subarray(17));

  if (kind === KIND_UPDATE) {
    Y.applyUpdate(doc.ydoc, payload, REMOTE_ORIGIN);
  } else if (kind === KIND_AWARENESS) {
    applyAwarenessUpdate(doc.awareness, payload, REMOTE_ORIGIN);
  }
});

function publish(pageId: string, kind: number, payload: Uint8Array): void {
  const frame = Buffer.concat([REPLICA_ID, Buffer.from([kind]), Buffer.from(payload)]);
  publisher.publish(channel(pageId), frame).catch((err: Error) =>
    logger.error({ err, pageId }, "failed to publish to redis"),
  );
}

function broadcastLocal(doc: Doc, data: Uint8Array, except?: unknown): void {
  for (const socket of doc.sockets) {
    if (socket === except) continue;
    socket.send(data);
  }
}

function scheduleSnapshot(doc: Doc): void {
  if (doc.snapshotTimer) return; // already pending; debounce rather than reset
  doc.snapshotTimer = setTimeout(() => {
    doc.snapshotTimer = undefined;
    void flush(doc);
  }, config.SNAPSHOT_DEBOUNCE_MS);
}

export async function flush(doc: Doc): Promise<void> {
  if (!doc.dirty) return;
  doc.dirty = false;
  try {
    await saveSnapshot(doc.pageId, Y.encodeStateAsUpdate(doc.ydoc));
    snapshotWrites.inc({ outcome: "ok" });
  } catch (err) {
    // Put the flag back: a failed write must not be silently forgotten, or the
    // edits it covered are lost at unload.
    doc.dirty = true;
    snapshotWrites.inc({ outcome: "error" });
    logger.error({ err, pageId: doc.pageId }, "snapshot write failed");
  }
}

export async function getDoc(pageId: string): Promise<Doc> {
  const existing = docs.get(pageId);
  if (existing) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
    }
    return existing;
  }

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  awareness.setLocalState(null); // the server is not a participant

  const snapshot = await loadSnapshot(pageId);
  if (snapshot) Y.applyUpdate(ydoc, snapshot, REMOTE_ORIGIN);

  const doc: Doc = { pageId, ydoc, awareness, sockets: new Set(), dirty: false };

  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    const started = process.hrtime.bigint();

    // Frame it once for every local peer. Message type 0 is a sync message,
    // and messageUpdate (2) is the y-protocols "here is an update" variant.
    broadcastLocal(doc, encodeSyncUpdate(update), origin);

    if (origin !== REMOTE_ORIGIN) {
      publish(pageId, KIND_UPDATE, update);
      doc.dirty = true;
      scheduleSnapshot(doc);
    }

    syncLatency.observe(Number(process.hrtime.bigint() - started) / 1e9);
  });

  awareness.on("update", ({ added, updated, removed }: any, origin: unknown) => {
    const changed = [...added, ...updated, ...removed];
    if (changed.length === 0) return;
    const payload = encodeAwarenessUpdate(awareness, changed);
    broadcastLocal(doc, encodeAwarenessMessage(payload), origin);
    if (origin !== REMOTE_ORIGIN) publish(pageId, KIND_AWARENESS, payload);
  });

  await subscriber.subscribe(channel(pageId));
  docs.set(pageId, doc);
  loadedDocuments.set(docs.size);
  logger.info({ pageId, restored: Boolean(snapshot) }, "document loaded");
  return doc;
}

export function releaseDoc(doc: Doc): void {
  if (doc.sockets.size > 0) return;

  // Do not unload immediately. A rolling update disconnects everyone at once
  // and they reconnect within seconds; unloading on the last disconnect would
  // mean a database read and a full state rebuild for every one of them.
  doc.idleTimer = setTimeout(() => {
    if (doc.sockets.size > 0) return;
    void (async () => {
      if (doc.snapshotTimer) clearTimeout(doc.snapshotTimer);
      await flush(doc);
      await subscriber.unsubscribe(channel(doc.pageId));
      doc.awareness.destroy();
      doc.ydoc.destroy();
      docs.delete(doc.pageId);
      loadedDocuments.set(docs.size);
      logger.info({ pageId: doc.pageId }, "document unloaded");
    })();
  }, config.DOC_IDLE_TTL_MS);
}

export function allDocs(): Doc[] {
  return [...docs.values()];
}
