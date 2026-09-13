# Window-close crash (SIGSEGV) under `deno task dev` (`--watch`)

Status: root-caused via dynamic debugging; worked around by dropping `--watch`
from the `dev` task. Upstream report (Deno) still open.

## Environment

- Deno 2.9.3 (stable, x86_64-unknown-linux-gnu), Fedora Workstation (debuginfod
  available, systemd-coredump configured but storing nothing)
- `@sigmasd/gtk@0.65.0` (GTK4, `Application` + `ApplicationWindow`)
- `@webview/webview@0.9.0` (native plug `.so` from `~/.cache/deno/plug`,
  WebKitGTK 6.0, GPU compositing active — Radeon/vulkan, `VBlankMonitor` thread
  present)
- App: `src/webview/main.ts` opens the window, embeds the webview, serves `web/`
  from `src/backend/server.ts` (worker). Close handler:
  `window.onCloseRequest(() => Deno.exit(0))`.

## Symptoms

- `deno task dev` (`deno run -A --watch=src/ src/webview/main.ts`): close the
  window → terminal hangs for ~8-10s, Ctrl-C appears dead, then the process dies
  (fish: `terminated by signal SIGSEGV`). No Ctrl-C is needed for the crash
  itself.
- Plain `deno run -A src/webview/main.ts` (no `--watch`): close exits cleanly in
  well under a second, every time observed.
- Page console shows `ping stream failed … TypeError: Load failed` for each
  monitor during teardown (page dying as its host unloads — noise, not cause).

## Red herrings eliminated

1. **`onCloseRequest` not firing** — disproven: no-watch mode exits instantly
   through the same callback, so it fires and `Deno.exit` works. The
   `@sigmasd/gtk` binding (`connectBool("close-request", …)`) is fine.
2. **`app.quit()` vs `Deno.exit(0)`** — moot: both paths end in the same
   `Deno.exit(0)` (main.ts falls through to it) and the same teardown.
3. **GC'd FFI callback** — no evidence; the callback demonstrably runs.
4. **Webview intercepting the close** — no evidence; default close handling
   proceeds in both modes.
5. **[denoland/deno#20956](https://github.com/denoland/deno/issues/20956)**
   ("dlopen on a modified file segfaults at exit") — ruled out: nothing
   overwrites any `.so` in our runs; our open/close refcounting is balanced
   (plug `.so` 1/1, `libwebkitgtk` 2/2); our crash site is a live foreign
   thread, while #20956's repro is single-threaded with an empty symbol table.
   Side finding: #20956 **still reproduces on Deno 2.9.3** (`this is reached`,
   then `exit=139`) despite being Closed.

## Method: `LD_AUDIT` unload tracer

`Deno.dlopen`'d libraries are closed at exit teardown, so every exit runs a
`dlclose` cascade. To watch it, a ~60-line `LD_AUDIT` library logging
`timestamp + pid:tid + open/close + path` per object (write-only, no malloc —
safe inside the loader):

```c
#define _GNU_SOURCE
#include <link.h>
#include <unistd.h>
#include <time.h>
#include <stdio.h>

unsigned int la_version(unsigned int version) { return LAV_CURRENT; }

static void emit(const char *tag, const char *name)
{
  char buf[640];
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  if (!name || !*name)
    name = "(main)";
  int n = snprintf(buf, sizeof buf, "[%ld.%09ld] pid=%d tid=%d %s %s\n",
                   (long)ts.tv_sec, ts.tv_nsec, (int)getpid(),
                   (int)gettid(), tag, name);
  if (n > 0)
    write(STDERR_FILENO, buf, (size_t)n);
}

unsigned int la_objopen(struct link_map *map, Lmid_t lmid,
                        uintptr_t *cookie)
{
  (void)lmid;
  if (cookie)
    *cookie = (uintptr_t)map;
  if (map && map->l_name)
    emit("open", map->l_name);
  return LA_FLG_BINDTO | LA_FLG_BINDFROM;
}

unsigned int la_objclose(uintptr_t *cookie)
{
  struct link_map *map = cookie ? (struct link_map *)*cookie : NULL;
  const char *name = (map && map->l_name) ? map->l_name : "(?)";
  emit("close", name);
  return 0;
}
```

```sh
gcc -shared -fPIC -Wall -o audit.so audit.c
LD_AUDIT=$PWD/audit.so deno task dev 2>crash.log   # then close window
```

Notes: every process sharing the redirected stderr logs into one file (app,
watcher, `deno task` wrapper, `ping`/`ip` children, WebKit helpers) — the `pid:`
field is what separates them. `ping` children contribute small open/close
bursts; ignore them.

## Evidence

### gdb backtrace (watch mode, close window)

- Thread 1 (main): `0 _dl_close_worker` ← `_dl_close` ← `dlclose` ← Deno
  teardown frames. The process is inside `dlclose` during exit.
- Thread `VBlankMonitor`: `SIGSEGV` at an unmapped address with a garbage stack
  (all `??` — debuginfod was off). Textbook use-after-`dlclose`: a thread
  executing library code that was just unmapped. Other live threads at death:
  WebKit `ReceiveQueue`, `WebsiteDataStore`, `PressureMonitor`, gallium/vulkan
  GL workers.

### Per-PID audit timeline (watch-mode crash run)

| pid        | role                                   | first     | last        | lines   |
| ---------- | -------------------------------------- | --------- | ----------- | ------- |
| 1879415    | `deno task` wrapper                    | .632      | .289 (+10s) | 17      |
| 1879422    | app (`--watch` + program, one process) | .639      | **.589**    | 343     |
| 1879457    | WebKit helper process                  | .866      | .291        | 389     |
| 1879458/63 | `ping` children                        | .867/.880 | .289        | 15 each |
| 1879522    | `ip monitor` child                     | +1.5s     | .289        | 13      |

- At `.588` the app starts unloading, in order: `libadwaita` →
  appstream/`libcurl` cone → webview plug `.so` → `libwebkitgtk` (refcount 2→1)
  → webkit dep cone (icu, flite, harfbuzz, codecs…).
- The app's stream **ends abruptly ~1ms later** (`.589`, `close libvmaf.so.3`) —
  mid-cascade, no `libgtk`/`glib`/`libc`/`ld` closes. The app died there:
  SIGSEGV ~0.1s after close.
- Everything else exits ~8s later within 2ms of each other (WebKit helper's own
  cascade ending `.291`, pings, task wrapper) — the user's Ctrl-C landing on the
  whole foreground group. That 8s gap is the perceived "hang"; the dead Ctrl-Cs
  during it are SIGINTs to a group stuck behind orphan-held stdio pipes.
- No-watch baseline: the **lib-for-lib identical cascade order** completes fully
  in ~43ms. Clean exit, no strays (`pgrep` clean — Deno reaps spawned children
  on clean exit).

## Root cause

Use-after-`dlclose` during exit teardown: Deno drops its FFI-loaded native
libraries starting ~1ms after close while WebKit's UI-process threads
(vsync-driven `VBlankMonitor` ~16ms cadence, GL workers) are still running. If
one ticks mid-unload → SIGSEGV.

`--watch` correlation: unload order is deterministic and identical in both modes
(HashMap-randomness theory dead), so the difference is timing — watcher teardown
(inotify thread, channels) interleaved in the exit path widens the race window
past the point where a vsync tick mid-unload goes from possible to certain.
No-watch wins the same race in 43ms. Caveat: trial count is small; five clean
no-watch closes vs consistent watch crashes is the standing observation.

## Workaround applied

`dev` task runs without `--watch` (`deno run -A src/webview/main.ts`). Page
edits never needed a restart (`web/` is served from disk); only backend edits
need a manual restart. README updated accordingly.

## Open / upstream

- Minimized repro for a Deno report: tiny script that `dlopen`s gtk +
  webkitgtk-webview equivalent and calls `Deno.exit` — our app plus these logs
  may already suffice as the report body.
- Exact faulting library/function would need a debuginfod-enabled gdb run
  (`set debuginfod enabled on` — was off, hence `??` frames); Deno's own frames
  will stay unresolved (stripped upstream binary).
- Re-verify if Deno changes FFI teardown ordering or `--watch` exit handling;
  then `--watch` can go back on the `dev` task.
- #20956 still reproducing on 2.9.3 deserves its own "still broken" comment with
  the exit-139 transcript.
