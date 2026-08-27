import {
  DIRECT_UPDATE_POLICY,
  SOURCE_INTEGRATION_UPDATE_POLICY,
} from "./update-policy.mjs";

export function createUpdaterCoordinator(
  updater,
  setState,
  policy = DIRECT_UPDATE_POLICY,
  options = {},
) {
  const sourceIntegration = policy?.mode === SOURCE_INTEGRATION_UPDATE_POLICY.mode;
  const openReleaseNotes = typeof options?.openReleaseNotes === "function" ? options.openReleaseNotes : null;
  let sourceVersion = null;
  let checkOperation = null;
  let downloadOperation = null;
  let installOperation = null;
  const routedErrors = new WeakSet();

  const routeError = (manual, error) => {
    if (error instanceof Error) routedErrors.add(error);
    if (downloadOperation) downloadOperation.failed = true;
    if (checkOperation) checkOperation.failed = true;
    if (installOperation) {
      installOperation.failed = true;
      clearTimeout(installOperation.timer);
      installOperation = null;
    }
    sourceVersion = null;
    if (!manual) {
      if (sourceIntegration) {
        setState({ status: "idle", mode: undefined, releaseNotesUrl: undefined });
        return;
      }
      setState({ status: "idle" });
      return;
    }
    if (sourceIntegration) {
      setState({
        status: "error",
        message: String(error?.message ?? error),
        mode: undefined,
        releaseNotesUrl: undefined,
      });
      return;
    }
    setState({ status: "error", message: String(error?.message ?? error) });
  };

  function handleRejectedOperation(manual, error) {
    if (error instanceof Error && routedErrors.has(error)) return;
    routeError(manual, error);
  }

  function checkOwnsState() {
    return !downloadOperation && !checkOperation?.supersededByDownload;
  }

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) setState({ status: "checking" });
  });
  updater.on("update-available", (info) => {
    if (checkOwnsState()) {
      if (sourceIntegration) {
        sourceVersion = info?.version;
        setState({
          status: "available",
          version: sourceVersion,
          message: undefined,
          mode: SOURCE_INTEGRATION_UPDATE_POLICY.mode,
          releaseNotesUrl: SOURCE_INTEGRATION_UPDATE_POLICY.releaseNotesUrl,
        });
      } else {
        setState({ status: "available", version: info?.version, message: undefined });
      }
    }
  });
  updater.on("update-not-available", () => {
    if (checkOwnsState()) {
      if (sourceIntegration) {
        sourceVersion = null;
        setState({ status: "idle", mode: undefined, releaseNotesUrl: undefined });
      } else {
        setState({ status: "idle" });
      }
    }
  });
  // downloadUpdate/checkForUpdates reject after most updater errors, but the
  // macOS native staging pass used by quitAndInstall is event-only. Without
  // this listener a Squirrel.Mac failure leaves the renderer on "Restarting"
  // forever because quitAndInstall itself returns void.
  updater.on("error", (error) => {
    const manual = Boolean(installOperation || downloadOperation || checkOperation?.manual);
    routeError(manual, error);
  });
  updater.on("download-progress", (progress) => {
    if (sourceIntegration) return;
    setState({ status: "downloading", percent: Math.round(progress?.percent ?? 0) });
  });
  updater.on("update-downloaded", (info) => {
    if (sourceIntegration) return;
    // On macOS electron-updater emits this before Squirrel.Mac has finished
    // staging the ZIP. Keep the UI in downloading until downloadUpdate's
    // promise resolves, which is the point the native updater is ready.
    if (downloadOperation) {
      downloadOperation.downloadedInfo = info;
      return;
    }
    setState({ status: "downloaded", version: info?.version });
  });

  function openSourceReleaseNotes() {
    try {
      return Promise.resolve(openReleaseNotes?.(SOURCE_INTEGRATION_UPDATE_POLICY.releaseNotesUrl)).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  function restoreSourceState() {
    if (!sourceIntegration) return;
    if (sourceVersion) {
      setState({
        status: "available",
        version: sourceVersion,
        mode: SOURCE_INTEGRATION_UPDATE_POLICY.mode,
        releaseNotesUrl: SOURCE_INTEGRATION_UPDATE_POLICY.releaseNotesUrl,
      });
    } else {
      setState({ status: "idle", mode: undefined, releaseNotesUrl: undefined });
    }
  }

  function check(manual = false) {
    if (checkOperation) {
      // A manual caller upgrades the shared operation; a timer never downgrades it.
      if (manual) checkOperation.manual = true;
      return checkOperation.promise;
    }

    const operation = { manual, supersededByDownload: Boolean(downloadOperation), failed: false, promise: null };
    checkOperation = operation;
    try {
      operation.promise = Promise.resolve(updater.checkForUpdates())
        .catch((error) => {
          if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
        })
        .finally(() => {
          if (checkOperation === operation) checkOperation = null;
        });
    } catch (error) {
      if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
      checkOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function download() {
    if (sourceIntegration) {
      restoreSourceState();
      return openSourceReleaseNotes();
    }
    if (checkOperation) checkOperation.supersededByDownload = true;
    if (downloadOperation) return downloadOperation.promise;

    const operation = { downloadedInfo: null, failed: false, promise: null };
    downloadOperation = operation;
    // Own the state before the request goes out: the first "download-progress"
    // can be seconds away (connection setup, redirects), and until then the
    // renderer would still show an untouched "Download" button. No percent yet
    // — the UI reads a missing percent as "starting".
    setState({ status: "downloading" });
    try {
      operation.promise = Promise.resolve(updater.downloadUpdate())
        .then((result) => {
          if (!operation.failed && operation.downloadedInfo) {
            setState({ status: "downloaded", version: operation.downloadedInfo?.version });
          }
          return result;
        })
        .catch((error) => handleRejectedOperation(true, error))
        .finally(() => {
          if (downloadOperation === operation) downloadOperation = null;
        });
    } catch (error) {
      handleRejectedOperation(true, error);
      downloadOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function install() {
    if (sourceIntegration) {
      restoreSourceState();
      return openSourceReleaseNotes();
    }
    if (installOperation) return;
    const operation = { failed: false, timer: null };
    installOperation = operation;
    setState({ status: "installing" });
    try {
      updater.quitAndInstall(true, true);
    } catch (error) {
      routeError(true, error);
      return;
    }
    // quitAndInstall is void. If neither a quit nor an updater error arrives,
    // recover the UI instead of spinning for the lifetime of the process.
    if (installOperation === operation) {
      operation.timer = setTimeout(() => {
        if (installOperation !== operation) return;
        installOperation = null;
        setState({ status: "error", message: "The update could not be staged. Quit the app and try again." });
      }, 2 * 60 * 1000);
      operation.timer.unref?.();
    }
  }

  return { check, download, install };
}
