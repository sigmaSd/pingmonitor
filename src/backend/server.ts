#!/usr/bin/env -S deno run --allow-net --allow-read --allow-run
/// <reference lib="deno.worker" />

import "@sigma/deno-compile-extra/fetchPatch";

function startPingSession(socket: WebSocket, host: string) {
  stopPing();

  const cmd = new Deno.Command("ping", {
    args: [host],
    stdout: "piped",
    stderr: "piped",
  });

  const process = cmd.spawn();
  currentProcess = process;

  // Handle stdout
  (async () => {
    try {
      const stream = process.stdout.pipeThrough(new TextDecoderStream());
      for await (const value of stream) {
        if (process !== currentProcess) break;

        const match = value.match(/time=(\d+(\.\d+)?)/);
        if (match) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ ping: parseFloat(match[1]) }));
          }
        }
      }
    } catch (_error) {
      // Ignore
    }
  })();

  // Handle stderr for errors (like unknown host)
  (async () => {
    try {
      const stderrStream = process.stderr.pipeThrough(new TextDecoderStream());
      for await (const chunk of stderrStream) {
        if (process !== currentProcess) break;
        if (chunk.trim().length > 0) {
          console.error("Ping stderr:", chunk);
          // Simple heuristic to show relevant errors
          if (
            chunk.includes("unknown host") ||
            chunk.includes("Temporary failure") ||
            chunk.includes("Name or service not known")
          ) {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  message: `Ping failed: ${chunk.trim()}`,
                }),
              );
            }
          }
        }
      }
    } catch (_e) {
      // Ignore
    }
  })();

  // Handle process exit
  process.status.then((status) => {
    if (
      process === currentProcess && !status.success && status.code !== 0 &&
      status.signal === null
    ) {
      // It exited with error, and wasn't killed by us (signal would be set if we killed it usually, though Deno's kill might differ, checking currentProcess is safer)
      if (socket.readyState === WebSocket.OPEN) {
        // Only send generic exit error if we haven't likely sent a specific stderr one, or just generic.
        // For now, let's rely on stderr for specific text, or just say it exited.
        // socket.send(JSON.stringify({ type: "error", message: "Ping process exited unexpectedly." }));
      }
    }
  });
}

let currentProcess: Deno.ChildProcess | null = null;
let currentHost = "1.1.1.1";

function stopPing() {
  if (currentProcess) {
    try {
      currentProcess.kill();
    } catch (_e) {
      // Ignore
    }
    currentProcess = null;
  }
}

if (import.meta.main) {
  Deno.serve({
    port: 0,
    onListen: ({ port }) => {
      console.log(`Server running on http://localhost:${port}`);
      if (self.postMessage) self.postMessage({ port });
    },
  }, async (req) => {
    const path = new URL(req.url).pathname;

    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);

      console.log("New WebSocket connection");

      socket.addEventListener("open", () => {
        console.log("WebSocket connection opened");
        // Start default ping
        startPingSession(socket, currentHost);
      });

      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "updateHost" && data.host) {
            currentHost = data.host;
            startPingSession(socket, currentHost);
          } else if (data.type === "pause") {
            stopPing();
          } else if (data.type === "resume") {
            startPingSession(socket, currentHost);
          }
        } catch (e) {
          console.error("Error handling message:", e);
        }
      });

      socket.addEventListener("close", () => {
        console.log("WebSocket connection closed");
        stopPing();
      });

      return response;
    }

    if (path === "/" || path === "/index.html") {
      const html = await fetch(import.meta.resolve("../frontend/index.html"))
        .then((res) => res.text());
      return new Response(html, {
        headers: { "content-type": "text/html" },
      });
    }

    if (path.startsWith("/assets/")) {
      const assetPath = path.replace("/assets/", "");
      const fileUrl = import.meta.resolve(`../frontend/assets/${assetPath}`);
      try {
        const file = await fetch(fileUrl);
        if (!file.ok) return new Response("Not Found", { status: 404 });

        const contentType = assetPath.endsWith(".css")
          ? "text/css"
          : assetPath.endsWith(".ttf")
          ? "font/ttf"
          : "application/octet-stream";

        return new Response(file.body, {
          headers: { "content-type": contentType },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    if (path === "/favicon.ico") {
      return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
        <path fill="#4CAF50" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>
        <path fill="#4CAF50" d="M12 6c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4z"/>
        <circle fill="#4CAF50" cx="12" cy="12" r="2"/>
      </svg>`,
        {
          headers: { "content-type": "image/svg+xml" },
        },
      );
    }

    return new Response("Not Found", { status: 404 });
  });
}
