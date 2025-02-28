#!/usr/bin/env -S deno run --allow-all
import { Webview } from "jsr:@webview/webview@0.9.0";
import { patchFetch } from "../utils.ts";
patchFetch();

const _worker = new Worker(import.meta.resolve("../backend/server.ts"), {
  type: "module",
});

const webview = new Webview(true);
webview.title = "Ping";
webview.navigate("http://localhost:3000");
webview.run();

Deno.exit(0);
