// Cross-platform process spawning for the agent CLIs. Three Windows
// differences are exposed to drivers through this module:
//   1. CreateProcess can't exec npm .cmd/.bat shims or node-shebang scripts
//      directly. env-path resolves those to their real .exe / `node script`
//      entry without a shell, so quoting-sensitive JSON argv stays intact.
//   2. No process-group kill (kill(-pid) is POSIX) — taskkill /T reaps the
//      whole tree, CLI + its spawned MCP proxies alike.
//   3. Console apps spawned from the GUI shell flash a console window
//      unless windowsHide is set.
import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";

export interface ExecCliTreeOptions extends Omit<SpawnOptions, "stdio"> {
  timeout?: number;
  maxBuffer?: number;
}

export function resolveCli(cli: string, args: string[] = []): ResolvedSpawn {
  return resolveCliSpawn(cli, args);
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  // SAFETY: stdio is fixed to three pipes by this function, matching the
  // ChildProcessByStdio generic used by every caller below.
  const child = spawn(resolved.command, resolved.args, {
    ...opts,
    // posix: own process group so kill(-pid) reaps child MCP servers;
    // win32: taskkill /T does the reaping instead (see killCliTree)
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  }) as ChildProcessByStdio<Writable, Readable, Readable>; // callers always pipe all three

  // A write to a dying child's stdin fails differently per platform, and one
  // of the ways is fatal. On POSIX the kill is synchronous, the stream is
  // already destroyed by the time anything writes, and the write throws into
  // the caller's try/catch. On Windows killCliTree goes through taskkill — a
  // subprocess — so there is a window where the child is dead but its pipe is
  // not, and a write during it errors *asynchronously* on the stream. No
  // driver listens for that, an unlistened stream error is an uncaught
  // exception, and the whole harness exits over one dead CLI. The error
  // carries no information the drivers don't already get from `close`, which
  // is where every one of them settles the turn — so it is swallowed, not
  // logged.
  child.stdin?.on("error", () => {});
  return child;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  const resolved = resolveCli(cli, args);
  execFile(resolved.command, resolved.args, { ...opts, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) =>
    cb(err, stdout, stderr),
  );
}

/** Execute a bounded CLI command and reap its complete process tree on timeout.
 *
 * `execFile({ timeout })` only guarantees that the direct child is killed on
 * Windows. CLI launchers commonly leave their real worker process behind,
 * which then holds credentials, ports, and state files. This helper does not
 * settle a timeout until taskkill has finished with the whole tree. */
export function execCliTree(
  cli: string,
  args: string[],
  opts: ExecCliTreeOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { timeout = 0, maxBuffer = 1024 * 1024, ...spawnOptions } = opts;
  const child = spawnCli(cli, args, {
    ...spawnOptions,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopping = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    };

    const stopWith = async (error: Error) => {
      if (settled || stopping) return;
      stopping = true;
      await killCliTreeAndWait(child);
      finish(error);
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled || stopping) return;
      const next = (target === "stdout" ? stdout : stderr) + String(chunk);
      if (Buffer.byteLength(next, "utf8") > maxBuffer) {
        void stopWith(new Error(`${cli} exceeded maxBuffer (${maxBuffer} bytes)`));
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (stopping || settled) return;
      if (code === 0) finish();
      else {
        const detail = stderr.trim() || stdout.trim();
        finish(new Error(
          `${cli} exited ${code ?? signal ?? "before producing a result"}${detail ? `: ${detail}` : ""}`,
        ));
      }
    });

    if (timeout > 0) {
      timer = setTimeout(() => {
        void stopWith(new Error(`${cli} timed out after ${timeout}ms`));
      }, timeout);
    }
  });
}

/** Human wording for a failed CLI spawn.
 *
 * Node reports these as bare errno strings — "spawn grok ENOENT" — which
 * reads as a crash. On a CLI spawn the common codes mean exactly one thing
 * each, and both are setup problems the user can fix, so say which. The
 * `setup` flag lets the UI offer "Install" instead of a "Retry" that is
 * guaranteed to fail the same way. */
type SpawnFailure = { message: string; setup: boolean };

export function describeSpawnFailure(err: NodeJS.ErrnoException, cli: string): SpawnFailure {
  if (err.code === "ENOENT")
    return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
  if (err.code === "EACCES" || err.code === "EPERM")
    return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
  return { message: `spawn failed: ${err.message}`, setup: false };
}

/** Stop a CLI and every process it spawned (MCP proxies included). */
export function killCliTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (!err) return;
      try {
        // taskkill is unavailable or the tree lookup failed. At least stop
        // the process we own instead of leaving the entire turn running.
        child.kill();
      } catch {
        /* already gone */
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Promise form used by bounded probes that must not race the next command. */
export async function killCliTreeAndWait(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    const taskkillFailed = await new Promise<boolean>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) =>
        resolve(Boolean(error)),
      );
    });
    if (taskkillFailed && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        return;
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        return;
      }
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

/** Per-turn broker channel: unix socket on POSIX, named pipe on Windows
 * (Node can't listen on a filesystem socket path there — EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  return process.platform === "win32"
    // Named pipes share a global namespace; DATA_DIR cannot isolate two
    // concurrent app instances the way a POSIX socket directory does.
    ? `\\\\.\\pipe\\openmausbot-perm-${process.pid}-${tag}`
    : join(dataDir, `perm-${tag}.sock`);
}
