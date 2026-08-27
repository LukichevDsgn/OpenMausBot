import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const statePath = join(homedir(), ".codex", ".codex-global-state.json");
const rootPath = "D:\\Codex\\OpenMausBot-custom";
const projectName = "OpenMaus";

const state = JSON.parse(readFileSync(statePath, "utf8"));
state["local-projects"] ??= {};

const existing = Object.values(state["local-projects"]).find((project) =>
  project?.rootPaths?.some((value) => value.toLowerCase() === rootPath.toLowerCase()),
);

const now = Date.now();
const projectId = existing?.id ?? randomUUID();
state["local-projects"][projectId] = {
  id: projectId,
  name: projectName,
  rootPaths: [rootPath],
  createdAt: existing?.createdAt ?? now,
  updatedAt: now,
};

state["project-order"] ??= [];
state["project-order"] = [
  projectId,
  ...state["project-order"].filter((value) => value !== projectId),
];

state["pinned-project-ids"] ??= [];
if (!state["pinned-project-ids"].includes(projectId)) {
  state["pinned-project-ids"].push(projectId);
}

state["project-appearances"] ??= {};
state["project-appearances"][projectId] ??= {
  color: "blue",
  marker: { kind: "icon", icon: "terminal" },
};

const stamp = new Date().toISOString().replaceAll(":", "-");
const backupPath = `${statePath}.before-openmaus-project-${stamp}.bak`;
copyFileSync(statePath, backupPath);

const tempPath = `${statePath}.openmaus-project.tmp`;
writeFileSync(tempPath, JSON.stringify(state), "utf8");
renameSync(tempPath, statePath);

const written = JSON.parse(readFileSync(statePath, "utf8"));
const registered = written["local-projects"]?.[projectId];
if (!registered || registered.rootPaths?.[0] !== rootPath) {
  throw new Error("OpenMaus project registration did not persist");
}

console.log(JSON.stringify({ projectId, projectName, rootPath, backupPath }));
