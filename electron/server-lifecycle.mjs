const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the embedded server to dispose provider children before Electron exits.
 * `utilityProcess.kill()` is only the bounded fallback: killing the host first
 * can orphan CLI grandchildren on Windows.
 */
export async function stopEmbeddedServer({ proc, port, fetchImpl = fetch, timeoutMs = 5_000 }) {
  if (!proc) return { graceful: true, reason: "absent" };

  let onExit;
  const exited = new Promise((resolve) => {
    onExit = () => resolve(true);
    proc.once("exit", onExit);
  });

  try {
    await fetchImpl(`http://127.0.0.1:${port}/api/internal/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(Math.min(timeoutMs, 2_000)),
    });
  } catch {
    // The server may close the socket while exiting. The process exit below is
    // authoritative; a failed request merely keeps the kill fallback armed.
  }

  if (await Promise.race([exited, delay(timeoutMs).then(() => false)])) {
    return { graceful: true, reason: "server-exited" };
  }

  proc.removeListener?.("exit", onExit);
  try {
    proc.kill();
  } catch {}
  return { graceful: false, reason: "timeout-killed" };
}
