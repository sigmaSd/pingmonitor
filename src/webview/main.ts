#!/usr/bin/env -S deno run --allow-all
import { SizeHint, Webview } from "jsr:@webview/webview@0.9.0";
import "jsr:@sigma/deno-compile-extra@0.10.0/fetchPatch";
import "jsr:@sigma/deno-compile-extra@0.10.0/localStoragePolyfill";

// Load the theme preference from localStorage
let themePreference: string | null = null;
try {
  // Using Deno's localStorage API to persist theme between app sessions
  themePreference = localStorage.getItem("theme");
} catch (e) {
  console.error("Could not access localStorage:", e);
}

const worker = new Worker(import.meta.resolve("../backend/server.ts"), {
  type: "module",
});

worker.onmessage = (event) => {
  const port = event.data.port;
  const webview = new Webview(true);
  webview.title = "Ping";
  webview.size = { width: 800, height: 600, hint: SizeHint.NONE };

  // Set up binding to save theme
  webview.bind("saveTheme", (theme: string) => {
    console.log("Saving theme preference:", theme);
    try {
      localStorage.setItem("theme", theme);
      themePreference = theme;
    } catch (e) {
      console.error("Failed to save theme preference:", e);
    }
    return {};
  });

  // Pass the initial theme to the frontend
  webview.bind("getInitialTheme", () => {
    console.log("Providing initial theme:", themePreference);
    return themePreference;
  });

  webview.navigate(`http://localhost:${port}`);
  webview.run();

  Deno.exit(0);
};
