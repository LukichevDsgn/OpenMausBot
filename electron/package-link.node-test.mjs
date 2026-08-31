import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  enableGrokBotLinkHandler,
  grokBotLinkHandlerStatus,
  grokBotProtocolClientContract,
  packageUrlFromCommandLine,
  packageUrlFromDeepLink,
} from "./package-link.mjs";

const grokShareId = "Abcdefghijklmnopqrstu";
const grokLink = `grokbot://app/v1/bot-template?id=${grokShareId}`;

describe("BotMRR package deep links", () => {
  it("accepts a public GitHub package URL", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromCommandLine(["OpenMausBot", "--flag", `openmausbot://install?url=${encodeURIComponent(target)}`]), target);
  });

  it("accepts the exact Grok Bot link from initial and second-instance argv", () => {
    assert.equal(packageUrlFromDeepLink(grokLink), grokLink);
    assert.equal(packageUrlFromCommandLine(["OpenMausBot.exe", grokLink]), grokLink);
    assert.equal(
      packageUrlFromCommandLine(["OpenMausBot.exe", "--second-instance", grokLink]),
      grokLink,
    );

    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    assert.match(main, /pendingPackageInstallUrl\s*=\s*packageUrlFromCommandLine\(process\.argv\)/);
    assert.match(main, /app\.on\("second-instance",[\s\S]*?packageUrlFromCommandLine\(commandLine\)/);
    assert.match(main, /webContents\.send\("package:install", pendingPackageInstallUrl\)/);

    const sidebar = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
    assert.match(sidebar, /onPackageInstall\?\.\(\(url\)\s*=>\s*\{\s*setTeamInstallUrl\(url\);\s*setTeamLibraryOpen\(true\)/);
  });

  it("rejects Grok Bot credentials, fragments, extra query, and invalid IDs", () => {
    for (const value of [
      `grokbot://user@app/v1/bot-template?id=${grokShareId}`,
      `${grokLink}#fragment`,
      `${grokLink}&extra=1`,
      `grokbot://app/v1/bot-template?id=${grokShareId.slice(1)}`,
      `grokbot://app/v1/bot-template?id=${grokShareId}%20`,
      `grokbot://app/v1/bot-template?id=${grokShareId}0`,
      `grokbot://app/v1/bot-template?id=${grokShareId.toLowerCase()}!`,
      `grokbot://app/v1/bot-template/?id=${grokShareId}`,
      `grokbot://app:99/v1/bot-template?id=${grokShareId}`,
    ]) assert.equal(packageUrlFromDeepLink(value), null, value);
  });

  it("rejects other commands, hosts, protocols, credentials, and unsupported file types", () => {
    assert.equal(packageUrlFromDeepLink("openmausbot://settings"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://evil.example/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=http://raw.githubusercontent.com/a/b/main/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://user@example.com/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://github.com/acme/bot/run.sh"), null);
  });

  it("keeps Grok registration Windows-only, packaged-only, and opt-in", () => {
    let currentDefault = false;
    const calls = [];
    const executablePath = "D:\\OpenMausBot\\OpenMausBot.exe";
    const api = {
      platform: "win32",
      packaged: true,
      executablePath,
      isDefaultProtocolClient: (scheme, executable, args) =>
        scheme === "grokbot" && executable === executablePath && args.length === 0 && currentDefault,
      setAsDefaultProtocolClient: (scheme, executable, args) => {
        calls.push([scheme, executable, args]);
        currentDefault = scheme === "grokbot" && executable === executablePath && args.length === 0;
        return currentDefault;
      },
    };

    assert.deepEqual(grokBotProtocolClientContract(api), {
      protocol: "grokbot",
      executablePath,
      arguments: [],
    });
    assert.deepEqual(grokBotLinkHandlerStatus(api), { supported: true, isDefault: false });
    assert.deepEqual(calls, [], "status must not register the protocol");
    assert.deepEqual(enableGrokBotLinkHandler(api), {
      supported: true,
      isDefault: true,
      registrationSucceeded: true,
    });
    assert.deepEqual(calls, [["grokbot", executablePath, []]]);

    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(main, /setAsDefaultProtocolClient\(\s*["']grokbot["']/);

    for (const input of [
      { platform: "linux", packaged: true, executablePath: "/opt/OpenMausBot" },
      { platform: "darwin", packaged: true, executablePath: "/Applications/OpenMausBot.app" },
      { platform: "win32", packaged: false, executablePath: "D:\\repo\\electron.exe" },
      { platform: "win32", packaged: true, executablePath: "OpenMausBot.exe" },
      { platform: "win32", packaged: true, executablePath: "D:\\release\\OpenMausBot.cmd" },
    ]) assert.equal(grokBotProtocolClientContract(input), null);
  });
});
