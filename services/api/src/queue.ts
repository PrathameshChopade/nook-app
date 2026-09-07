import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

export const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export type ExportJob = { exportId: string; pageId: string; format: "markdown" | "pdf" };

// The API only ever produces. It has no Worker, deliberately: doing the work
// in the request process would make export latency the user's problem and
// couple the API's replica count to export throughput.
export const exportQueue = new Queue<ExportJob>("exports", { connection });
