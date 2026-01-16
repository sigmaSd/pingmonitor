#!/usr/bin/env -S deno run --allow-all
import { SizeHint, Webview } from "@webview/webview";
import "@sigma/deno-compile-extra/fetchPatch";
import "@sigma/deno-compile-extra/localStoragePolyfill";
import { Application, ApplicationWindow } from "@sigmasd/gtk/gtk";

function waitForPort(worker: Worker) {
  return new Promise((resolve) => {
    worker.onmessage = (event) => {
      resolve(event.data.port);
    };
  });
}

if (import.meta.main) {
  const worker = new Worker(import.meta.resolve("../backend/server.ts"), {
    type: "module",
  });

  const port = await waitForPort(worker);

  const app = new Application("io.github.sigmasd.pingmonitor", 0);

  app.onActivate(() => {
    const window = new ApplicationWindow(app);
    window.setTitle("Ping Monitor");
    window.setDefaultSize(1000, 600);
    window.setVisible(true);

    const webview = new Webview(false, undefined, window.ptr);
    webview.title = "Ping Monitor";
    webview.size = { width: 1000, height: 600, hint: SizeHint.NONE };

    webview.navigate(`http://localhost:${port}`);
  });

  app.run(Deno.args);
}

Deno.exit(0);
