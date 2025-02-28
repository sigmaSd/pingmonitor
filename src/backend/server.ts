#!/usr/bin/env -S deno run --allow-net --allow-read --allow-run

import { patchFetch } from "../utils.ts";
patchFetch();

async function* pingGenerator(pingHost = "8.8.8.8") {
  const process = new Deno.Command("ping", {
    args: [pingHost],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  for await (
    const value of process.stdout.pipeThrough(new TextDecoderStream())
  ) {
    const match = value.match(/time=(\d+(\.\d+)?)/);
    if (match) {
      yield parseFloat(match[1]);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (import.meta.main) {
  Deno.serve({ port: 3000 }, async (req) => {
    const path = new URL(req.url).pathname;

    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);

      console.log("New WebSocket connection");

      socket.addEventListener("open", async () => {
        console.log("WebSocket connection opened");

        for await (const ping of pingGenerator()) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ ping }));
          } else {
            break;
          }
        }
      });

      socket.addEventListener("close", () => {
        console.log("WebSocket connection closed");
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

  console.log("Server running on http://localhost:3000");
}
