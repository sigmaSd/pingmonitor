#!/usr/bin/env -S deno run --allow-all
import { Webview } from "jsr:@webview/webview@0.9.0";
import { patchFetch } from "../utils.ts";
patchFetch();

const worker = new Worker(import.meta.resolve("../backend/server.ts"), {
  type: "module",
});
worker.onmessage = (event) => {
  const port = event.data.port;
  const webview = new Webview(true);
  webview.title = "Ping";
  webview.navigate(`http://localhost:${port}`);
  webview.run();

  Deno.exit(0);
};
