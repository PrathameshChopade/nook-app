import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

// BullMQ requires maxRetriesPerRequest to be null on the connection it uses
// for blocking commands. Leaving the default makes workers die under a brief
// Redis blip instead of waiting it out.
export const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const EXPORT_QUEUE = "exports";
export const MAINTENANCE_QUEUE = "maintenance";

export type ExportJob = { exportId: string; pageId: string; format: "markdown" | "pdf" };

export const exportQueue = new Queue<ExportJob>(EXPORT_QUEUE, {
  connection,
  defaultJobOptions: {
    // Exponential backoff, because the usual reason an export fails is that
    // something downstream is briefly unavailable, and retrying immediately
    // just adds load to whatever is already struggling.
    attempts: 4,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 24 * 3_600 },
  },
});
