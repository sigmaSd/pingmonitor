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
    if (process === currentProcess) {
      // Process exited unexpectedly (not killed by stopPing)
      if (!status.success) {
        console.log("Ping process exited unexpectedly, retrying in 2s...");
        if (socket.readyState === WebSocket.OPEN) {
          retryTimeout = setTimeout(() => {
            startPingSession(socket, host);
          }, 2000);
        }
      }
    }
  });
}

let currentProcess: Deno.ChildProcess | null = null;
let currentHost = "1.1.1.1";
let retryTimeout: number | undefined;

function stopPing() {
  if (currentProcess) {
    try {
      currentProcess.kill();
    } catch (_e) {
      // Ignore
    }
    currentProcess = null;
  }
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = undefined;
  }
}

let speedInterval: number | undefined;
let previousRx = 0;
let previousTx = 0;
let previousTime = 0;

async function getNetworkStats(): Promise<{ rx: number; tx: number }> {
  try {
    const data = await Deno.readTextFile("/proc/net/dev");
    const lines = data.split("\n");
    let totalRx = 0;
    let totalTx = 0;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // Replace colon with space to handle "eth0:123" and "eth0: 123" uniformly
      const parts = line.replace(/:/g, " ").trim().split(/\s+/);

      if (parts[0].startsWith("lo")) continue; // Skip loopback

      // parts[0] is name, parts[1] is rx_bytes, parts[9] is tx_bytes
      const rx = parseInt(parts[1]);
      const tx = parseInt(parts[9]);

      if (!isNaN(rx)) totalRx += rx;
      if (!isNaN(tx)) totalTx += tx;
    }
    return { rx: totalRx, tx: totalTx };
  } catch (e) {
    console.error("Error reading network stats:", e);
    return { rx: 0, tx: 0 };
  }
}

async function startSpeedSession(socket: WebSocket) {
  stopSpeedSession();

  const stats = await getNetworkStats();
  previousRx = stats.rx;
  previousTx = stats.tx;
  previousTime = Date.now();

  speedInterval = setInterval(async () => {
    if (socket.readyState !== WebSocket.OPEN) {
      stopSpeedSession();
      return;
    }

    const currentStats = await getNetworkStats();
    const currentTime = Date.now();
    const timeDiff = (currentTime - previousTime) / 1000; // seconds

    if (timeDiff > 0) {
      const rxSpeed = Math.max(0, (currentStats.rx - previousRx) / timeDiff);
      const txSpeed = Math.max(0, (currentStats.tx - previousTx) / timeDiff);

      socket.send(JSON.stringify({
        speed: {
          rx: rxSpeed,
          tx: txSpeed,
        },
      }));

      previousRx = currentStats.rx;
      previousTx = currentStats.tx;
      previousTime = currentTime;
    }
  }, 1000);
}

function stopSpeedSession() {
  if (speedInterval) {
    clearInterval(speedInterval);
    speedInterval = undefined;
  }
}

let networkWatcher: Deno.ChildProcess | null = null;
let networkDebounceTimer: number | undefined;

function sendNetworkInfo(socket: WebSocket) {
  if (socket.readyState !== WebSocket.OPEN) return;

  try {
    const interfaces = Deno.networkInterfaces().filter((i) =>
      i.family === "IPv4" && !i.address.startsWith("127.")
    );

    // 1. Send local info immediately (it's always available)
    socket.send(JSON.stringify({
      type: "networkInfo",
      publicIp: "Updating...",
      interfaces,
    }));

    // 2. Fetch public IP in background
    (async () => {
      // Create a fresh client to bypass connection pooling and force new DNS/TCP lookup
      // This is critical for VPN switching where the old connection becomes invalid
      const client = Deno.createHttpClient({});
      try {
        const res = await fetch(
          `https://ip.sigmasd.workers.dev/api?t=${Date.now()}`,
          { client },
        );
        const data = await res.json();

        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: "networkInfo",
            publicIp: data.ip,
            interfaces,
          }));
        }
      } catch {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: "networkInfo",
            publicIp: "Error",
            interfaces,
          }));
        }
      } finally {
        try {
          client.close();
        } catch { /* ignore */ }
      }
    })();
  } catch (e) {
    console.error("Error in sendNetworkInfo:", e);
  }
}

function startNetworkWatcher(socket: WebSocket) {
  stopNetworkWatcher();

  const cmd = new Deno.Command("ip", {
    args: ["monitor", "address", "route"],
    stdout: "piped",
    stderr: "piped",
  });

  networkWatcher = cmd.spawn();
  const process = networkWatcher;

  // Handle process exit
  process.status.then((status) => {
    if (process === networkWatcher && !status.success) {
      console.error(`Network watcher exited with code ${status.code}`);
    }
  });

  (async () => {
    try {
      const stream = process.stdout.pipeThrough(new TextDecoderStream());
      for await (const chunk of stream) {
        if (process !== networkWatcher) break;

        if (chunk.trim().length > 0) {
          // Debounce the update to avoid spamming during connection changes
          if (networkDebounceTimer) clearTimeout(networkDebounceTimer);
          networkDebounceTimer = setTimeout(() => {
            sendNetworkInfo(socket);
          }, 2000); // Wait 2s for connection to settle
        }
      }
    } catch (e) {
      console.error("Error in network watcher stream:", e);
    }
  })();

  // Also log stderr
  (async () => {
    try {
      const stream = process.stderr.pipeThrough(new TextDecoderStream());
      for await (const chunk of stream) {
        if (process !== networkWatcher) break;
        console.error("Network watcher stderr:", chunk);
      }
    } catch (_e) { /* ignore */ }
  })();
}

function stopNetworkWatcher() {
  if (networkWatcher) {
    try {
      networkWatcher.kill();
    } catch (_e) {
      // Ignore
    }
    networkWatcher = null;
  }
  if (networkDebounceTimer) {
    clearTimeout(networkDebounceTimer);
    networkDebounceTimer = undefined;
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
        startSpeedSession(socket);

        // Initial network info
        sendNetworkInfo(socket);
        // Start watching for changes
        startNetworkWatcher(socket);
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
        stopSpeedSession();
        stopNetworkWatcher();
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
