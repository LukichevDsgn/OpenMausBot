// Update-source policy for this build.  The policy is data-only so callers
// cannot accidentally turn source integration into a binary installation.
export const OFFICIAL_RELEASE_NOTES_URL =
  "https://github.com/milind-soni/openmausbot-releases/releases";

export const OFFICIAL_GITHUB_FEED = Object.freeze({
  provider: "github",
  owner: "milind-soni",
  repo: "openmausbot-releases",
});

export const OFFICIAL_UPDATE_FEED = OFFICIAL_GITHUB_FEED;
export const SOURCE_INTEGRATION_FEED = OFFICIAL_GITHUB_FEED;

export const DIRECT_UPDATE_POLICY = Object.freeze({
  mode: "direct",
});

export const SOURCE_INTEGRATION_UPDATE_POLICY = Object.freeze({
  mode: "source-integration",
  autoDownload: false,
  autoInstallOnAppQuit: false,
  releaseNotesUrl: OFFICIAL_RELEASE_NOTES_URL,
  feed: OFFICIAL_GITHUB_FEED,
});

// Alias kept intentionally small and descriptive for callers that only need
// to name the source-integration policy.
export const SOURCE_INTEGRATION_POLICY = SOURCE_INTEGRATION_UPDATE_POLICY;

export function createSourceIntegrationPolicy() {
  return SOURCE_INTEGRATION_UPDATE_POLICY;
}

// Keep the feed configuration and the native safety flags in one small,
// testable boundary. Errors intentionally propagate to updater.mjs, whose
// startup path fails closed before creating the coordinator or timers.
export function applySourceIntegrationUpdatePolicy(updater) {
  if (!updater || typeof updater.setFeedURL !== "function") {
    throw new TypeError("updater feed configuration unavailable");
  }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.setFeedURL(OFFICIAL_GITHUB_FEED);
  return SOURCE_INTEGRATION_UPDATE_POLICY;
}
