// Stage Google's official Android Platform Tools beside the packaged app so
// USB phone support works on a clean machine without Homebrew or an SDK.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getReleaseSpec,
  installValidatedPlatformTools,
  releaseArchiveUrl,
  validateArchiveBytes,
  validateArchiveEntryNames,
} from "./android-platform-tools-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.platform;
const spec = getReleaseSpec(platform);

const finalDir = join(root, "dist-native", "android-platform-tools", platform);
const override = process.env.OMB_ANDROID_PLATFORM_TOOLS_SOURCE;
const temporary = mkdtempSync(join(tmpdir(), "openmaus-android-tools-"));

try {
  if (override) {
    installValidatedPlatformTools({
      sourceRoot: override,
      finalDir,
      platform,
      sourceKind: "operator-override",
    });
  } else {
    const url = releaseArchiveUrl(platform);
    const response = await fetch(url);
    if (!response.ok) throw new Error("could not download Android Platform Tools: HTTP " + response.status);
    const zipBytes = Buffer.from(await response.arrayBuffer());
    validateArchiveBytes(zipBytes, spec);
    const zip = join(temporary, spec.archiveFilename);
    writeFileSync(zip, zipBytes);
    const listing = listArchiveEntries(zip);
    validateArchiveEntryNames(listing);
    const extraction = join(temporary, "extracted");
    mkdirSync(extraction, { recursive: true });
    // A bare "tar" is Windows' bundled bsdtar (zip-capable) in cmd/PowerShell
    // but git-bash puts GNU tar (cannot read .zip) ahead of it on PATH, so
    // name the System32 binary absolutely. unzip remains the fallback for a
    // rare Windows installation without System32 tar.
    const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const extractors = process.platform === "win32"
      ? [[systemTar, ["-xf", zip, "-C", extraction]], ["unzip", ["-q", zip, "-d", extraction]]]
      : [["unzip", ["-q", zip, "-d", extraction]]];
    const describeFailure = (result) => result.error?.message ??
      (`${result.stderr || result.stdout || ""}`.trim() || `exit status ${result.status}`);
    let result;
    for (const [command, args] of extractors) {
      result = spawnSync(command, args, { encoding: "utf8" });
      if (result.status === 0) break;
      console.error(`${command} failed: ${describeFailure(result)} — trying next`);
    }
    if (result.status !== 0) throw new Error(`could not extract Android Platform Tools: ${describeFailure(result)}`);
    installValidatedPlatformTools({
      sourceRoot: join(extraction, "platform-tools"),
      finalDir,
      platform,
      sourceKind: "pinned-archive",
    });
  }

  console.log("staged Android Platform Tools at " + finalDir);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function listArchiveEntries(zipPath) {
  const command = process.platform === "win32" ? "tar" : "unzip";
  const args = process.platform === "win32" ? ["-tf", zipPath] : ["-Z1", zipPath];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(command + " could not list archive entries: " + (result.stderr || result.stdout).trim());
  }
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
