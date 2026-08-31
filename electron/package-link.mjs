import { win32 as windowsPath } from "node:path";

const ALLOWED_PACKAGE_HOSTS = new Set(["github.com", "www.github.com", "raw.githubusercontent.com"]);
const GROK_BOT_DEEP_LINK = /^grokbot:\/\/app\/v1\/bot-template\?id=[A-Za-z0-9_-]{21}$/;
const GROK_BOT_PROTOCOL = "grokbot";

export function packageUrlFromDeepLink(rawValue) {
  const raw = String(rawValue);
  if (GROK_BOT_DEEP_LINK.test(raw)) return raw;

  let link;
  try {
    link = new URL(raw);
  } catch {
    return null;
  }
  if (link.protocol !== "openmausbot:" || link.hostname !== "install") return null;
  const rawPackage = link.searchParams.get("url");
  if (!rawPackage) return null;
  let packageUrl;
  try {
    packageUrl = new URL(rawPackage);
  } catch {
    return null;
  }
  if (
    packageUrl.protocol !== "https:" ||
    packageUrl.username ||
    packageUrl.password ||
    packageUrl.port ||
    !ALLOWED_PACKAGE_HOSTS.has(packageUrl.hostname) ||
    !packageUrl.pathname.match(/\.(?:md|json)$/)
  ) return null;
  return packageUrl.toString();
}

export function packageUrlFromCommandLine(argv) {
  for (const value of argv) {
    const parsed = packageUrlFromDeepLink(value);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The Grok protocol is deliberately a user opt-in on Windows. Keep the
 * registration contract pure so callers can check or enable it without
 * touching the network, credentials, or the default openmausbot association.
 */
export function grokBotProtocolClientContract({ platform, packaged, executablePath }) {
  if (
    platform !== "win32" ||
    packaged !== true ||
    typeof executablePath !== "string" ||
    !windowsPath.isAbsolute(executablePath) ||
    windowsPath.extname(executablePath).toLowerCase() !== ".exe"
  ) return null;
  return {
    protocol: GROK_BOT_PROTOCOL,
    executablePath,
    arguments: [],
  };
}

export function grokBotLinkHandlerStatus({
  platform,
  packaged,
  executablePath,
  isDefaultProtocolClient,
}) {
  const contract = grokBotProtocolClientContract({ platform, packaged, executablePath });
  const supported = contract !== null;
  let isDefault = false;
  if (contract) {
    try {
      isDefault = isDefaultProtocolClient(
        contract.protocol,
        contract.executablePath,
        contract.arguments,
      ) === true;
    } catch {
      isDefault = false;
    }
  }
  return { supported, isDefault };
}

export function enableGrokBotLinkHandler({
  platform,
  packaged,
  executablePath,
  isDefaultProtocolClient,
  setAsDefaultProtocolClient,
}) {
  const input = { platform, packaged, executablePath, isDefaultProtocolClient };
  const before = grokBotLinkHandlerStatus(input);
  if (!before.supported) return { ...before, registrationSucceeded: false };
  const contract = grokBotProtocolClientContract(input);
  let registrationSucceeded = false;
  try {
    registrationSucceeded = setAsDefaultProtocolClient(
      contract.protocol,
      contract.executablePath,
      contract.arguments,
    ) === true;
  } catch {
    registrationSucceeded = false;
  }
  const after = grokBotLinkHandlerStatus(input);
  return { ...after, registrationSucceeded };
}
