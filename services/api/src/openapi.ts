// Writes the OpenAPI document to stdout without starting a listener.
//
// Stage 05 runs this in CI and publishes the result as a build artifact, then
// diffs it against the previous release to fail the build on a breaking
// change. That is what keeps a future mobile client from being broken by a
// backend merge — and it only works because the document is generated from
// the same schemas the server validates with, never hand-written.
import { buildApp } from "./app.js";

const app = await buildApp();
await app.ready();
process.stdout.write(JSON.stringify(app.swagger(), null, 2) + "\n");
await app.close();
process.exit(0);
