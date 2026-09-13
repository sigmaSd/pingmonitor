#!/usr/bin/env -S deno run --allow-all
import { SizeHint, Webview } from "@webview/webview";
import { Application, ApplicationWindow } from "@sigmasd/gtk/gtk4";

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

    // Workaround: exit the process directly when the window is closed.
    // app.quit() lets the close proceed into native webview teardown, which
    // blocks the main thread for seconds (Deno's SIGINT handler starves, so
    // Ctrl-C does nothing meanwhile). Exiting here skips that teardown
    // entirely -- the OS reclaims the window. Returns never, which satisfies
    // the close-request callback signature.
    window.onCloseRequest(() => {
      Deno.exit(0);
    });

    const webview = new Webview(true, undefined, window.ptr);
    webview.bind("show_app", () => {
      window.setVisible(true);
      // @webview/webview's bind() needs a JSON-serializable return value --
      // an implicit `undefined` return here produced "Failed to parse
      // binding result as JSON" as an unhandled rejection on the page side
      // (harmless since setVisible(true) already ran, but noisy). Verified
      // by removing it and seeing the error disappear.
      return true;
    });
    webview.title = "Ping Monitor";
    webview.size = { width: 1000, height: 600, hint: SizeHint.NONE };

    webview.navigate(`http://localhost:${port}`);
  });

  app.run(Deno.args);
}

Deno.exit(0);
