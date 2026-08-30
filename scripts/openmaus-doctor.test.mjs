import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { renderReport, runDoctor } from "./openmaus-doctor.mjs";

const health = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fake = (routes) => async (url) => routes[new URL(url).pathname] ?? new Response("not found", { status: 404 });

test("clean health is green and human report is concise", async () => {
  const report = await runDoctor({ fetcher: fake({ "/api/health": health({ app: "openmausbot", pid: 7 }) }) });
  expect(report.exitCode).toBe(0); // absent optional route is explicit INFO, not an invented failure
  expect(renderReport(report)).toMatch(/PASS health/);
  expect(renderReport(report)).toMatch(/INFO status/);
});

test("wrong identity, invalid JSON, and unreachable are failures", async () => {
  for (const response of [health({ app: "other" }), new Response("{", { status: 200 })]) {
    const report = await runDoctor({ fetcher: fake({ "/api/health": response }) });
    expect(report.exitCode).toBe(2);
    expect(report.checks.find((item) => item.name === "health").level).toBe("FAIL");
  }
  const report = await runDoctor({ endpoint: "http://127.0.0.1:1", timeoutMs: 50 });
  expect(report.exitCode).toBe(2);
  expect(report.checks.find((item) => item.name === "health").state).toBe("unreachable");
});

test("status/capsule validates effect and source/build digest agreement", async () => {
  const mismatch = await runDoctor({ fetcher: fake({ "/api/health": health({ app: "openmausbot" }), "/api/status": health({ app: "openmausbot", ready: true, sourceSha256: "a".repeat(64), buildSha256: "b".repeat(64) }) }) });
  expect(mismatch.exitCode).toBe(2);
  expect(mismatch.checks.find((item) => item.name === "status").message).toMatch(/mismatch/);
  const clean = await runDoctor({ fetcher: fake({ "/api/health": health({ app: "openmausbot" }), "/api/status": health({ app: "openmausbot", ready: true, sourceSha256: "a".repeat(64), buildSha256: "a".repeat(64) }) }) });
  expect(clean.exitCode).toBe(0);
});

test("watch is opt-in, hashes without baseline, and detects missing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmaus-doctor-"));
  const file = join(root, "watched.txt");
  await writeFile(file, "hello");
  try {
    const report = await runDoctor({ fetcher: fake({ "/api/health": health({ app: "openmausbot" }), "/api/status": health({ app: "openmausbot", ready: true }) }), watches: [file] });
    expect(report.exitCode).toBe(0);
    const before = report.checks.find((item) => item.name === "watch").sha256;
    expect(before).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    await writeFile(file, "changed");
    const after = (await runDoctor({ fetcher: fake({ "/api/health": health({ app: "openmausbot" }), "/api/status": health({ app: "openmausbot", ready: true }) }), watches: [file] })).checks.find((item) => item.name === "watch").sha256;
    expect(after, "a changed watched file must produce a changed digest").not.toBe(before);
    const missing = await runDoctor({ fetcher: fake({ "/api/health": health({ app: "openmausbot" }) }), watches: [join(root, "missing")] });
    expect(missing.exitCode).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("json and quiet semantics expose machine data or only warnings/failures", async () => {
  const report = await runDoctor({ fetcher: fake({ "/api/health": health({ app: "openmausbot" }) }) });
  const json = renderReport(report, { json: true });
  expect(JSON.parse(json).exitCode).toBe(0);
  expect(renderReport(report, { quiet: true })).toBe("OK");
  expect(renderReport(report, { quiet: true })).not.toMatch(/PASS health/);
  expect((await runDoctor({ fetcher: fake({ "/api/health": health({ app: "wrong" }) }) })).exitCode).toBe(2);
});

test("local HTTP negative control proves response effect, not TCP only", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ app: "not-openmausbot", ready: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const report = await runDoctor({ endpoint: `http://127.0.0.1:${address.port}` });
    expect(report.exitCode).toBe(2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
