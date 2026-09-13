#!/usr/bin/env -S deno run --allow-all
// Android dev loop: build the APK with denoapk, install it on a connected
// device/emulator, launch it, and stream its logs (the shell forwards page
// console.* to logcat under the "denoapk" tag, so this is where your
// console.log goes on-device).
//
//   deno task dev:android [--device <serial>] [--no-logs]
//
// Device selection: --device flag, else $ANDROID_SERIAL, else the only
// connected device, else the first of several (printed, so it's explicit).

// denoapk's shell activity, fully qualified (a leading-dot name would resolve
// against the per-app manifest package and miss the dex class).
const SHELL_ACTIVITY = "dev.denoapk.shell.MainActivity";

const root = new URL("..", import.meta.url).pathname;

async function run(
  cmd: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let out;
  try {
    out = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: cannot run ${cmd[0]}: ${msg}`);
    Deno.exit(1);
  }
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

async function runLive(cmd: string[]): Promise<number> {
  const child = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await child.status).code;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  Deno.exit(1);
}

interface Device {
  serial: string;
  state: string;
}

function parseDevices(adbOutput: string): Device[] {
  return adbOutput.split("\n").slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0] !== "")
    .map(([serial, state]) => ({ serial, state }));
}

if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
  console.log(`usage: dev:android [--device <serial>] [--no-logs]

Builds the APK (denoapk), installs it on a connected Android
device/emulator, launches it, and streams its logcat output.
With several devices attached, pick one via --device or $ANDROID_SERIAL.`);
  Deno.exit(0);
}

let deviceFlag: string | undefined;
let followLogs = true;
for (let i = 0; i < Deno.args.length; i++) {
  if (Deno.args[i] === "--device") {
    deviceFlag = Deno.args[++i];
    if (!deviceFlag) fail("--device needs a serial (see `adb devices`)");
  } else if (Deno.args[i] === "--no-logs") {
    followLogs = false;
  } else {
    fail(`unknown arg ${Deno.args[i]} (see --help)`);
  }
}

const config = JSON.parse(
  await Deno.readTextFile(`${root}/deno.json`),
);
const identifier: string | undefined = config?.desktop?.app?.identifier;
if (!identifier) fail("deno.json has no desktop.app.identifier");
const apkName = `${identifier.split(".").pop()}.apk`;
const apk = `${root}/dist/${apkName}`;

const adb = await run(["adb", "devices"]);
if (adb.code !== 0) fail(`\`adb devices\` failed:\n${adb.stderr.trim()}`);
const devices = parseDevices(adb.stdout);
const ready = devices.filter((d) => d.state === "device");
if (ready.length === 0) {
  const hint = devices.length > 0
    ? `found but not ready: ${
      devices.map((d) => `${d.serial} (${d.state})`).join(", ")
    }`
    : "none attached";
  fail(
    `no usable Android device (${hint}) -- connect one over USB, start an emulator, or \`adb pair\` a wireless one`,
  );
}

const wanted = deviceFlag ?? Deno.env.get("ANDROID_SERIAL");
let serial: string;
if (wanted) {
  if (!ready.some((d) => d.serial === wanted)) {
    fail(
      `device ${wanted} not found among ready devices: ${
        ready.map((d) => d.serial).join(", ")
      }`,
    );
  }
  serial = wanted;
} else {
  serial = ready[0].serial;
  if (ready.length > 1) {
    console.log(
      `note: ${ready.length} devices attached, using ${serial} (--device or $ANDROID_SERIAL to choose)`,
    );
  }
}
const adbS = (args: string[]) => ["adb", "-s", serial, ...args];

console.log(`building ${apkName} ...`);
if (
  await runLive([
    "deno",
    "run",
    "-A",
    "jsr:@sigmasd/denoapk",
    "build",
    root,
    "-o",
    apk,
  ]) !== 0
) {
  fail("denoapk build failed");
}

console.log(`installing on ${serial} ...`);
const install = await run([...adbS(["install", "-r", apk])]);
if (install.code !== 0) fail(`install failed:\n${install.stderr.trim()}`);
console.log(install.stdout.trim().split("\n").at(-1) ?? "installed");

console.log(`launching ${identifier} ...`);
const start = await run(
  [...adbS(["shell", "am", "start", "-n", `${identifier}/${SHELL_ACTIVITY}`])],
);
if (start.code !== 0) fail(`launch failed:\n${start.stderr.trim()}`);

if (!followLogs) Deno.exit(0);

// Fresh logcat so the dev loop starts at this launch, not pages of history.
await run([...adbS(["logcat", "-c"])]);
console.log(`--- logcat (${serial}), Ctrl-C to stop ---`);
Deno.exit(await runLive([...adbS(["logcat", "denoapk:I", "*:S"])]));
