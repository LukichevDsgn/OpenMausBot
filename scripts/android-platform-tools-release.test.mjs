import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PLATFORM_TOOLS_VERSION,
  RELEASE_SPECS,
  assertContainedPath,
  createReleaseManifest,
  getReleaseSpec,
  installValidatedPlatformTools,
  releaseArchiveUrl,
  serializeReleaseManifest,
  sha256Hex,
  validateArchiveBytes,
  validateArchiveEntryNames,
  validatePlatformToolsRoot,
} from "./android-platform-tools-release.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function toolNames(platform) {
  return platform === "win32" ? { adb: "adb.exe", fastboot: "fastboot.exe" } : { adb: "adb", fastboot: "fastboot" };
}

function makeTools(platform, options = {}) {
  const root = tempRoot("omb-platform-tools-fixture-");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "source.properties"), "Pkg.Revision=" + (options.revision ?? PLATFORM_TOOLS_VERSION) + "\n");
  const names = toolNames(platform);
  if (options.omit !== "adb") writeFileSync(join(root, names.adb), "adb fixture");
  if (options.omit !== "fastboot") writeFileSync(join(root, names.fastboot), "fastboot fixture");
  return root;
}

describe("Android Platform Tools release specs", () => {
  it("uses the frozen 37.0.1 versioned archive facts and never latest URLs", () => {
    expect(RELEASE_SPECS).toEqual({
      linux: {
        platform: "linux",
        version: "37.0.1",
        archiveFilename: "platform-tools_r37.0.1-linux.zip",
        byteSize: 9054187,
        sha256: "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1",
      },
      darwin: {
        platform: "darwin",
        version: "37.0.1",
        archiveFilename: "platform-tools_r37.0.1-darwin.zip",
        byteSize: 16110554,
        sha256: "ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d",
      },
      win32: {
        platform: "win32",
        version: "37.0.1",
        archiveFilename: "platform-tools_r37.0.1-win.zip",
        byteSize: 8044989,
        sha256: "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99",
      },
    });
    for (const platform of ["linux", "darwin", "win32"]) {
      const url = releaseArchiveUrl(platform);
      expect(url).toBe("https://dl.google.com/android/repository/" + getReleaseSpec(platform).archiveFilename);
      expect(url).not.toContain("latest");
    }
  });

  it("fails closed on wrong archive size and wrong SHA-256", () => {
    const spec = getReleaseSpec("linux");
    expect(() => validateArchiveBytes(Buffer.from("short"), spec)).toThrow(/byte size mismatch/);
    expect(() => validateArchiveBytes(Buffer.alloc(spec.byteSize), spec)).toThrow(/SHA-256 mismatch/);

    const fixture = Buffer.from("deterministic archive fixture");
    const fixtureSpec = {
      ...spec,
      byteSize: fixture.byteLength,
      sha256: sha256Hex(fixture),
    };
    expect(validateArchiveBytes(fixture, fixtureSpec)).toEqual({
      byteSize: fixture.byteLength,
      sha256: sha256Hex(fixture),
    });
  });

  it("emits deterministic pinned and operator-override manifests", () => {
    const pinned = createReleaseManifest("linux", "pinned-archive");
    expect(pinned).toEqual({
      schemaVersion: 1,
      releaseVersion: "37.0.1",
      platform: "linux",
      source: {
        kind: "pinned-archive",
        archiveFilename: "platform-tools_r37.0.1-linux.zip",
        byteSize: 9054187,
        sha256: "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1",
      },
    });
    expect(serializeReleaseManifest(pinned)).toBe(JSON.stringify(pinned, null, 2) + "\n");

    const override = createReleaseManifest("win32", "operator-override");
    expect(override).toEqual({
      schemaVersion: 1,
      releaseVersion: "37.0.1",
      platform: "win32",
      source: { kind: "operator-override" },
    });
    expect(JSON.stringify(override)).not.toMatch(/sha256|byteSize|archiveFilename/);
  });
});

describe("Android Platform Tools layout validation", () => {
  it("accepts the exact platform-specific layout and revision", () => {
    expect(validatePlatformToolsRoot(makeTools("linux"), "linux").revision).toBe("37.0.1");
    expect(validatePlatformToolsRoot(makeTools("darwin"), "darwin").fastbootPath).toMatch(/fastboot$/);
    expect(validatePlatformToolsRoot(makeTools("win32"), "win32").adbPath).toMatch(/adb\.exe$/);
  });

  it("rejects missing or wrong revision and missing platform binaries", () => {
    expect(() => validatePlatformToolsRoot(makeTools("linux", { revision: "37.0.2" }), "linux")).toThrow(
      /Pkg\.Revision mismatch/,
    );
    const missingSource = makeTools("linux");
    rmSync(join(missingSource, "source.properties"));
    expect(() => validatePlatformToolsRoot(missingSource, "linux")).toThrow(/source\.properties is missing/);
    expect(() => validatePlatformToolsRoot(makeTools("linux", { omit: "adb" }), "linux")).toThrow(/adb is missing/);
    expect(() => validatePlatformToolsRoot(makeTools("win32", { omit: "fastboot" }), "win32")).toThrow(
      /fastboot\.exe is missing/,
    );
  });

  it("rejects symlinks and paths escaping the stage", () => {
    const root = makeTools("linux");
    const external = tempRoot("omb-platform-tools-outside-");
    writeFileSync(join(external, "outside"), "outside");
    symlinkSync(external, join(root, "linked-directory"), "junction");
    expect(() => validatePlatformToolsRoot(root, "linux")).toThrow(/symbolic link/);

    const stage = tempRoot("omb-platform-tools-stage-");
    expect(() => assertContainedPath(stage, join(stage, "..", "outside"))).toThrow(/escapes stage/);
    expect(() =>
      validatePlatformToolsRoot(join(stage, "..", "outside-platform-tools"), "linux", { stageRoot: stage }),
    ).toThrow(/escapes stage/);
    expect(() => validateArchiveEntryNames(["platform-tools/adb", "platform-tools/fastboot"])).not.toThrow();
    for (const entry of ["../outside", "/platform-tools/adb", "C:/outside", "platform-tools/../outside", "other/adb"]) {
      expect(() => validateArchiveEntryNames([entry])).toThrow(/escapes platform-tools stage/);
    }
  });
});

describe("Android Platform Tools staged installation", () => {
  it("validates overrides, stages the copy, and labels the manifest", () => {
    const sourceRoot = makeTools("win32");
    const finalParent = tempRoot("omb-platform-tools-final-");
    const finalDir = join(finalParent, "win32");
    const manifest = installValidatedPlatformTools({
      sourceRoot,
      finalDir,
      platform: "win32",
      sourceKind: "operator-override",
    });
    expect(manifest.source).toEqual({ kind: "operator-override" });
    const written = JSON.parse(readFileSync(join(finalDir, "release.json"), "utf8"));
    expect(written).toEqual(manifest);
    expect(JSON.stringify(written)).not.toMatch(/sha256|byteSize|archiveFilename/);
    expect(lstatSync(join(finalDir, "adb.exe")).isFile()).toBe(true);
    expect(lstatSync(join(finalDir, "fastboot.exe")).isFile()).toBe(true);
  });

  it("writes the pinned manifest only after validation", () => {
    const sourceRoot = makeTools("linux");
    const finalParent = tempRoot("omb-platform-tools-final-");
    const finalDir = join(finalParent, "linux");
    const manifest = installValidatedPlatformTools({
      sourceRoot,
      finalDir,
      platform: "linux",
      sourceKind: "pinned-archive",
    });
    expect(JSON.parse(readFileSync(join(finalDir, "release.json"), "utf8"))).toEqual(manifest);
    expect(manifest.source).toMatchObject({
      kind: "pinned-archive",
      archiveFilename: "platform-tools_r37.0.1-linux.zip",
      byteSize: 9054187,
      sha256: "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1",
    });
  });

  it("leaves an existing final directory untouched when validation fails", () => {
    const sourceRoot = makeTools("linux", { revision: "37.0.2" });
    const finalParent = tempRoot("omb-platform-tools-final-");
    const finalDir = join(finalParent, "linux");
    mkdirSync(finalDir, { recursive: true });
    writeFileSync(join(finalDir, "sentinel.txt"), "preserve me");

    expect(() =>
      installValidatedPlatformTools({
        sourceRoot,
        finalDir,
        platform: "linux",
        sourceKind: "pinned-archive",
      }),
    ).toThrow(/Pkg\.Revision mismatch/);
    expect(readFileSync(join(finalDir, "sentinel.txt"), "utf8")).toBe("preserve me");
    expect(readFileSync(join(finalDir, "sentinel.txt"), "utf8")).not.toContain("37.0.2");
  });
});
