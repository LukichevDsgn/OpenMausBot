import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PLATFORM_TOOLS_VERSION = "37.0.1";
const ARCHIVE_BASE_URL = "https://dl.google.com/android/repository/";

const specs = {
  linux: Object.freeze({
    platform: "linux",
    version: PLATFORM_TOOLS_VERSION,
    archiveFilename: "platform-tools_r37.0.1-linux.zip",
    byteSize: 9054187,
    sha256: "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1",
  }),
  darwin: Object.freeze({
    platform: "darwin",
    version: PLATFORM_TOOLS_VERSION,
    archiveFilename: "platform-tools_r37.0.1-darwin.zip",
    byteSize: 16110554,
    sha256: "ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d",
  }),
  win32: Object.freeze({
    platform: "win32",
    version: PLATFORM_TOOLS_VERSION,
    archiveFilename: "platform-tools_r37.0.1-win.zip",
    byteSize: 8044989,
    sha256: "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99",
  }),
};

export const RELEASE_SPECS = Object.freeze(specs);

export function getReleaseSpec(platform) {
  const spec = RELEASE_SPECS[platform];
  if (!spec) throw new Error("Android Platform Tools are unsupported on " + platform);
  return spec;
}

export function releaseArchiveUrl(platform) {
  return ARCHIVE_BASE_URL + getReleaseSpec(platform).archiveFilename;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export function validateArchiveBytes(bytes, specOrPlatform) {
  const spec = typeof specOrPlatform === "string" ? getReleaseSpec(specOrPlatform) : specOrPlatform;
  if (!spec || !spec.platform) throw new Error("an Android Platform Tools release spec is required");
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength !== spec.byteSize) {
    throw new Error(
      "Android Platform Tools archive byte size mismatch for " +
        spec.platform +
        ": expected " +
        spec.byteSize +
        ", got " +
        buffer.byteLength,
    );
  }
  const actualSha256 = sha256Hex(buffer);
  if (actualSha256 !== spec.sha256) {
    throw new Error(
      "Android Platform Tools archive SHA-256 mismatch for " +
        spec.platform +
        ": expected " +
        spec.sha256 +
        ", got " +
        actualSha256,
    );
  }
  return { byteSize: buffer.byteLength, sha256: actualSha256 };
}

export function assertContainedPath(container, candidate) {
  const containerPath = resolve(container);
  const candidatePath = resolve(candidate);
  const relativePath = relative(containerPath, candidatePath);
  if (relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)) {
    throw new Error("path escapes stage: " + candidate);
  }
  return candidatePath;
}

function lstatRequired(filePath, label) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new Error(label + " is missing: " + filePath);
  }
  return stat;
}

function requireRegularFile(filePath, label) {
  const stat = lstatRequired(filePath, label);
  if (stat.isSymbolicLink()) throw new Error(label + " must not be a symbolic link: " + filePath);
  if (!stat.isFile()) throw new Error(label + " must be a regular file: " + filePath);
  return filePath;
}

function validateTreeNoSymlinks(rootPath, stageRoot) {
  for (const name of readdirSync(rootPath)) {
    const childPath = assertContainedPath(stageRoot, join(rootPath, name));
    const stat = lstatRequired(childPath, "staged entry");
    if (stat.isSymbolicLink()) throw new Error("staged entry must not be a symbolic link: " + childPath);
    if (stat.isDirectory()) validateTreeNoSymlinks(childPath, stageRoot);
  }
}

export function validatePlatformToolsRoot(root, platform, options = {}) {
  const spec = getReleaseSpec(platform);
  const rootPath = resolve(root);
  const stageRoot = options.stageRoot ? resolve(options.stageRoot) : rootPath;
  if (options.stageRoot) assertContainedPath(stageRoot, rootPath);

  const rootStat = lstatRequired(rootPath, "platform-tools root");
  if (rootStat.isSymbolicLink()) throw new Error("platform-tools root must not be a symbolic link: " + rootPath);
  if (!rootStat.isDirectory()) throw new Error("platform-tools root must be a directory: " + rootPath);
  validateTreeNoSymlinks(rootPath, stageRoot);

  const revisionPath = assertContainedPath(rootPath, join(rootPath, "source.properties"));
  requireRegularFile(revisionPath, "source.properties");
  const revisionMatch = readFileSync(revisionPath, "utf8").match(/(?:^|\r?\n)Pkg\.Revision\s*=\s*([^\r\n]+)/);
  const revision = revisionMatch?.[1]?.trim();
  if (revision !== spec.version) {
    throw new Error(
      "source.properties Pkg.Revision mismatch for " +
        spec.platform +
        ": expected " +
        spec.version +
        ", got " +
        (revision || "missing"),
    );
  }

  const adbName = platform === "win32" ? "adb.exe" : "adb";
  const fastbootName = platform === "win32" ? "fastboot.exe" : "fastboot";
  const adbPath = assertContainedPath(rootPath, join(rootPath, adbName));
  const fastbootPath = assertContainedPath(rootPath, join(rootPath, fastbootName));
  requireRegularFile(adbPath, adbName);
  requireRegularFile(fastbootPath, fastbootName);
  return { root: rootPath, platform: spec.platform, revision, adbPath, fastbootPath };
}

export function validateArchiveEntryNames(entries) {
  if (!Array.isArray(entries)) throw new Error("archive entries must be an array");
  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error("archive entry must be a string");
    let normalized = entry.replaceAll("\\", "/");
    while (normalized.startsWith("./")) normalized = normalized.slice(2);
    if (!normalized) continue;
    const parts = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      parts.includes("..") ||
      (parts[0] !== "platform-tools" && normalized !== "platform-tools")
    ) {
      throw new Error("archive entry escapes platform-tools stage: " + entry);
    }
  }
  return true;
}

export function createReleaseManifest(platform, sourceKind) {
  const spec = getReleaseSpec(platform);
  if (sourceKind === "pinned-archive") {
    return {
      schemaVersion: 1,
      releaseVersion: spec.version,
      platform: spec.platform,
      source: {
        kind: "pinned-archive",
        archiveFilename: spec.archiveFilename,
        byteSize: spec.byteSize,
        sha256: spec.sha256,
      },
    };
  }
  if (sourceKind === "operator-override") {
    return {
      schemaVersion: 1,
      releaseVersion: spec.version,
      platform: spec.platform,
      source: { kind: "operator-override" },
    };
  }
  throw new Error("unknown Android Platform Tools source: " + sourceKind);
}

export function serializeReleaseManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + "\n";
}

export function installValidatedPlatformTools({ sourceRoot, finalDir, platform, sourceKind }) {
  const temporary = mkdtempSync(join(tmpdir(), "openmaus-android-tools-stage-"));
  const staged = join(temporary, "platform-tools");
  try {
    validatePlatformToolsRoot(sourceRoot, platform);
    cpSync(sourceRoot, staged, { recursive: true, dereference: false });
    validatePlatformToolsRoot(staged, platform, { stageRoot: temporary });

    const manifest = createReleaseManifest(platform, sourceKind);
    writeFileSync(join(staged, "release.json"), serializeReleaseManifest(manifest));

    mkdirSync(dirname(finalDir), { recursive: true });
    rmSync(finalDir, { recursive: true, force: true });
    cpSync(staged, finalDir, { recursive: true, dereference: false });
    return manifest;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
