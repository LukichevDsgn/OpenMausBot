// Workspace credentials the desktop shell keeps OS-encrypted (credentials.bin
// via safeStorage) instead of leaving in plaintext config.json — the same
// treatment the Composio project key already gets in main.mjs. Pure functions:
// main.mjs owns the fs and safeStorage plumbing, so the migration decisions
// stay testable without an Electron runtime.
//
// One row per secret: the config.json home it migrates OUT of, the
// credentials.bin field it lives in, and the env var the spawned server
// prefers over the file (server/config.ts loadConfig).
export const WORKSPACE_CREDENTIALS = [
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  { section: "nvidia", field: "apiKey", name: "nvidiaApiKey", env: "NVIDIA_API_KEY" },
  { section: "openrouter", field: "apiKey", name: "openrouterApiKey", env: "OPENROUTER_API_KEY" },
  { section: "box", field: "token", name: "boxToken", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "ttsKey", env: "OMB_TTS_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
];

export function customEndpointEnvName(id) {
  return `OPENMAUSBOT_ENDPOINT_${String(id).toUpperCase()}_API_KEY`;
}

/** One boot-time sweep of config.json: move every plaintext workspace secret
 * into the encrypted store and DELETE the plaintext field.
 *
 * Deleting (never blanking) keeps "" meaningful. The server persists a
 * credential save by writing the field — a mid-session save lands as the new
 * value, a mid-session clear lands as "". So on the next boot:
 *   - non-empty value  → newest user intent: overwrite the stored secret
 *   - ""               → the user cleared it: drop the stored secret too
 *   - field absent     → already migrated: keep what the store holds
 * Running twice is a no-op, and nothing is lost if a boot dies between the
 * two writes — the caller persists credentials BEFORE rewriting config, so
 * the worst case re-runs the same overwrite.
 *
 * Inputs are treated as immutable; the changed flags tell the caller which
 * file(s) actually need rewriting. Non-string junk in a field is left for
 * the server's schema to reject rather than silently destroyed here. */
export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, field, name } of WORKSPACE_CREDENTIALS) {
    const home = nextConfig?.[section];
    if (!home || typeof home !== "object" || Array.isArray(home)) continue;
    if (!Object.hasOwn(home, field)) continue;
    const value = home[field];
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret) {
      if (nextCredentials[name] !== secret) {
        nextCredentials[name] = secret;
        credentialsChanged = true;
      }
    } else if (Object.hasOwn(nextCredentials, name)) {
      delete nextCredentials[name];
      credentialsChanged = true;
    }
    delete home[field];
    configChanged = true;
  }
  const endpoints = nextConfig?.customEndpoints;
  if (endpoints && typeof endpoints === "object" && !Array.isArray(endpoints)) {
    let endpointKeys = null;
    for (const [id, endpoint] of Object.entries(endpoints)) {
      if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint) || !Object.hasOwn(endpoint, "apiKey")) continue;
      const value = endpoint.apiKey;
      if (typeof value !== "string") continue;
      const secret = value.trim();
      if (!endpointKeys) endpointKeys = { ...(nextCredentials.customEndpointKeys ?? {}) };
      if (secret) endpointKeys[id] = secret;
      else delete endpointKeys[id];
      delete endpoint.apiKey;
      configChanged = true;
      credentialsChanged = true;
    }
    if (endpointKeys) nextCredentials.customEndpointKeys = endpointKeys;
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

/** Env for the spawned server: one var per stored secret, nothing else.
 * The server treats each var as authoritative over its config.json field. */
export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  const endpointKeys = credentials?.customEndpointKeys;
  if (endpointKeys && typeof endpointKeys === "object" && !Array.isArray(endpointKeys)) {
    for (const [id, value] of Object.entries(endpointKeys)) {
      if (typeof value === "string" && value) env[customEndpointEnvName(id)] = value;
    }
  }
  return env;
}

function secureMutationError(outcome, originalCause, rollbackCause, extra = {}) {
  const message = outcome === "rolled_back"
    ? "Credential update was rolled back"
    : "Credential update outcome is unknown; retry the same operation";
  const error = new Error(message);
  Object.defineProperties(error, {
    outcome: { value: outcome, enumerable: false, writable: false },
    originalCause: { value: originalCause, enumerable: false, writable: false },
    rollbackCause: { value: rollbackCause, enumerable: false, writable: false },
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, {
      value,
      enumerable: false,
      writable: false,
    }])),
  });
  return error;
}

function serverDisposition(result) {
  const outcome = result?.outcome ?? result?.body?.outcome;
  if (outcome === "success") return "success";
  if (outcome === "rolled_back") return "rolled_back";
  if (outcome === "unknown") return "unknown";
  if (result?.ok === true && (result.status === undefined || (result.status >= 200 && result.status < 300))) {
    return "success";
  }
  if (Number.isInteger(result?.status) && result.status >= 400 && result.status < 500) {
    return "rolled_back";
  }
  return "unknown";
}

/** Apply an encrypted credential mutation with a durable store-first order.
 * `request` must be idempotent for the operation/id and return a small
 * `{ok,status,outcome,body}` value instead of throwing for HTTP responses.
 * Transport rejection is the only condition retried, exactly once. */
export async function runWorkspaceCredentialMutation({
  previousCredentials,
  nextCredentials,
  writeCredentials,
  setCredentials,
  request,
}) {
  const previous = structuredClone(previousCredentials ?? {});
  const next = structuredClone(nextCredentials ?? {});
  try {
    await writeCredentials(next);
    await setCredentials?.(next);
  } catch (cause) {
    throw secureMutationError("unknown", cause, undefined, { storeWrite: true });
  }

  let response;
  let firstTransportCause;
  try {
    response = await request();
  } catch (cause) {
    firstTransportCause = cause;
    try {
      response = await request();
    } catch (secondTransportCause) {
      throw secureMutationError("unknown", firstTransportCause, undefined, { secondTransportCause });
    }
  }

  const disposition = serverDisposition(response);
  if (disposition === "success") return { response, credentials: next };
  if (disposition === "unknown") {
    throw secureMutationError("unknown", firstTransportCause ?? new Error("ambiguous server outcome"), undefined, {
      responseStatus: response?.status,
    });
  }

  try {
    await writeCredentials(previous);
    await setCredentials?.(previous);
  } catch (rollbackCause) {
    throw secureMutationError("unknown", new Error("server rejected credential mutation"), rollbackCause, {
      responseStatus: response?.status,
    });
  }
  throw secureMutationError("rolled_back", new Error("server rejected credential mutation"), undefined, {
    responseStatus: response?.status,
  });
}
