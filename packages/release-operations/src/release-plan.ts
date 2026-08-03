import { createHash } from "node:crypto";

export type ReleaseAction = "apply" | "rollback";

export interface ReleaseManifest {
  readonly backup: { readonly id: string; readonly verifiedAt: string };
  readonly canary: { readonly fixtureSet: string };
  readonly cloudflare: {
    readonly api: {
      readonly name: string;
      readonly previousVersion: string;
      readonly targetVersion: string;
    };
    readonly console: {
      readonly artifactDir: string;
      readonly branch: string;
      readonly previousArtifactDir: string;
      readonly previousCommit: string;
      readonly projectName: string;
      readonly targetDeployment: string;
    };
    readonly database: {
      readonly migrations: readonly string[];
      readonly name: string;
    };
  };
  readonly exitGate: {
    readonly apiHealthUrl: string;
    readonly stabilitySeconds: number;
  };
  readonly schemaVersion: 1;
  readonly sealos: {
    readonly context: string;
    readonly manifestPath: string;
    readonly namespace: string;
    readonly previousRevision: string;
    readonly revision: string;
    readonly rollbackManifestPath: string;
    readonly workloadName: string;
    readonly images: {
      readonly mihomo: { readonly previous: string; readonly target: string };
      readonly warp: { readonly previous: string; readonly target: string };
      readonly worker: { readonly previous: string; readonly target: string };
    };
  };
  readonly secrets: readonly { readonly name: string; readonly versionRef: string }[];
  readonly sourceCommit: string;
}

export interface ReleaseCommand {
  readonly args: readonly string[];
  readonly file: string;
}

export interface ReleaseStep {
  readonly commands: readonly ReleaseCommand[];
  readonly description: string;
  readonly id: string;
  readonly mutates: boolean;
  readonly rollbackCommands: readonly ReleaseCommand[];
}

export interface ReleasePlan {
  readonly action: ReleaseAction;
  readonly manifest: ReleaseManifest;
  readonly planHash: string;
  readonly steps: readonly ReleaseStep[];
}

const digestPattern = /^ghcr\.nju\.edu\.cn\/[^@]+@sha256:[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const root = record(value, "manifest");
  exactKeys(root, [
    "backup", "canary", "cloudflare", "exitGate", "schemaVersion", "sealos",
    "secrets", "sourceCommit",
  ], "manifest");
  rejectSensitiveMaterial(root, "manifest");
  if (root.schemaVersion !== 1) throw new Error("manifest.schemaVersion 必须为 1");
  const cloudflare = record(root.cloudflare, "manifest.cloudflare");
  const api = record(cloudflare.api, "manifest.cloudflare.api");
  const consoleTarget = record(cloudflare.console, "manifest.cloudflare.console");
  const database = record(cloudflare.database, "manifest.cloudflare.database");
  const sealos = record(root.sealos, "manifest.sealos");
  const images = record(sealos.images, "manifest.sealos.images");
  const backup = record(root.backup, "manifest.backup");
  const canary = record(root.canary, "manifest.canary");
  const exitGate = record(root.exitGate, "manifest.exitGate");
  exactKeys(cloudflare, ["api", "console", "database"], "manifest.cloudflare");
  exactKeys(api, ["name", "previousVersion", "targetVersion"], "manifest.cloudflare.api");
  exactKeys(consoleTarget, [
    "artifactDir", "branch", "previousArtifactDir", "previousCommit", "projectName",
    "targetDeployment",
  ], "manifest.cloudflare.console");
  exactKeys(database, ["migrations", "name"], "manifest.cloudflare.database");
  exactKeys(backup, ["id", "verifiedAt"], "manifest.backup");
  exactKeys(canary, ["fixtureSet"], "manifest.canary");
  exactKeys(exitGate, ["apiHealthUrl", "stabilitySeconds"], "manifest.exitGate");
  exactKeys(sealos, [
    "context", "images", "manifestPath", "namespace", "previousRevision", "revision",
    "rollbackManifestPath", "workloadName",
  ], "manifest.sealos");
  exactKeys(images, ["mihomo", "warp", "worker"], "manifest.sealos.images");

  const parsed: ReleaseManifest = {
    backup: {
      id: text(backup.id, "backup.id"),
      verifiedAt: timestamp(backup.verifiedAt, "backup.verifiedAt"),
    },
    canary: { fixtureSet: text(canary.fixtureSet, "canary.fixtureSet") },
    cloudflare: {
      api: {
        name: text(api.name, "cloudflare.api.name"),
        previousVersion: text(api.previousVersion, "cloudflare.api.previousVersion"),
        targetVersion: text(api.targetVersion, "cloudflare.api.targetVersion"),
      },
      console: {
        artifactDir: safePath(consoleTarget.artifactDir, "cloudflare.console.artifactDir"),
        branch: text(consoleTarget.branch, "cloudflare.console.branch"),
        previousArtifactDir: safePath(consoleTarget.previousArtifactDir, "cloudflare.console.previousArtifactDir"),
        previousCommit: commit(consoleTarget.previousCommit, "cloudflare.console.previousCommit"),
        projectName: text(consoleTarget.projectName, "cloudflare.console.projectName"),
        targetDeployment: text(consoleTarget.targetDeployment, "cloudflare.console.targetDeployment"),
      },
      database: {
        migrations: migrationList(database.migrations),
        name: text(database.name, "cloudflare.database.name"),
      },
    },
    exitGate: {
      apiHealthUrl: httpsUrl(exitGate.apiHealthUrl, "exitGate.apiHealthUrl"),
      stabilitySeconds: positiveInteger(exitGate.stabilitySeconds, "exitGate.stabilitySeconds"),
    },
    schemaVersion: 1,
    sealos: {
      context: kubeContext(sealos.context),
      images: {
        mihomo: imageVersions(images.mihomo, "sealos.images.mihomo"),
        warp: imageVersions(images.warp, "sealos.images.warp"),
        worker: imageVersions(images.worker, "sealos.images.worker"),
      },
      manifestPath: safePath(sealos.manifestPath, "sealos.manifestPath"),
      namespace: text(sealos.namespace, "sealos.namespace"),
      previousRevision: text(sealos.previousRevision, "sealos.previousRevision"),
      revision: text(sealos.revision, "sealos.revision"),
      rollbackManifestPath: safePath(sealos.rollbackManifestPath, "sealos.rollbackManifestPath"),
      workloadName: text(sealos.workloadName, "sealos.workloadName"),
    },
    secrets: secretRefs(root.secrets),
    sourceCommit: commit(root.sourceCommit, "sourceCommit"),
  };
  return parsed;
}

export function buildReleasePlan(
  action: ReleaseAction,
  manifest: ReleaseManifest,
): ReleasePlan {
  const steps = action === "apply" ? applySteps(manifest) : rollbackSteps(manifest);
  const planHash = createHash("sha256")
    .update(canonicalJson({ action, manifest, steps }))
    .digest("hex");
  return { action, manifest, planHash, steps };
}

function applySteps(manifest: ReleaseManifest): readonly ReleaseStep[] {
  const kubectl = kubectlPrefix(manifest);
  return [
    step("preflight", "校验提交、版本、digest、Secret 引用、备份与目标 context", false, [
      command("git", ["cat-file", "-e", `${manifest.sourceCommit}^{commit}`]),
      command("npm", ["run", "typecheck"]),
      command("npm", ["test"]),
      command("npm", ["exec", "--workspace", "@inbox/api", "--", "wrangler", "d1", "migrations", "list", manifest.cloudflare.database.name, "--remote"]),
      command("kubectl", ["config", "get-contexts", manifest.sealos.context, "-o", "name"]),
    ]),
    step("backup-evidence", `确认备份证据 ${manifest.backup.id}`, false),
    step("expand-migration", "应用 D1 expand migration", true, [
      command("npm", ["run", "db:migrate:remote", "--workspace", "@inbox/api"]),
    ]),
    step("api", "部署 Cloudflare Worker API", true, [
      command("npm", ["run", "deploy", "--workspace", "@inbox/api"]),
    ], [
      command("npm", ["exec", "--workspace", "@inbox/api", "--", "wrangler", "versions", "deploy", `${manifest.cloudflare.api.previousVersion}@100%`, "--name", manifest.cloudflare.api.name, "--yes"]),
    ]),
    step("console", "部署 Cloudflare Pages Console", true, [
      command("npm", ["run", "build", "--workspace", "@inbox/console"]),
      command("npm", ["exec", "--workspace", "@inbox/console", "--", "wrangler", "pages", "deploy", manifest.cloudflare.console.artifactDir, "--project-name", manifest.cloudflare.console.projectName, "--branch", manifest.cloudflare.console.branch, "--commit-hash", manifest.sourceCommit, "--commit-dirty=false"]),
    ], [
      command("npm", ["exec", "--workspace", "@inbox/console", "--", "wrangler", "pages", "deploy", manifest.cloudflare.console.previousArtifactDir, "--project-name", manifest.cloudflare.console.projectName, "--branch", manifest.cloudflare.console.branch, "--commit-hash", manifest.cloudflare.console.previousCommit, "--commit-dirty=false"]),
    ]),
    step("worker", "应用 Sealos Worker 三容器不可变 manifest", true, [
      command("kubectl", [...kubectl, "apply", "-f", manifest.sealos.manifestPath]),
      command("kubectl", [...kubectl, "rollout", "status", `statefulset/${manifest.sealos.workloadName}`]),
    ], [
      command("kubectl", [...kubectl, "apply", "-f", manifest.sealos.rollbackManifestPath]),
    ]),
    step("isolated-canary", `运行隔离 fixture ${manifest.canary.fixtureSet}`, false, [
      command("npm", ["test", "--workspace", "@inbox/worker", "--", "--run", "tests/canary.test.ts"]),
    ]),
    step("stability-window", "验证 API 健康、Worker rollout 与稳定窗口", false, [
      command("npm", [
        "run", "verify:live", "--workspace", "@inbox/api", "--",
        "--health-url", manifest.exitGate.apiHealthUrl,
        "--stability-seconds", String(manifest.exitGate.stabilitySeconds),
      ]),
      command("kubectl", [...kubectl, "rollout", "status", `statefulset/${manifest.sealos.workloadName}`]),
    ]),
  ];
}

function rollbackSteps(manifest: ReleaseManifest): readonly ReleaseStep[] {
  const kubectl = kubectlPrefix(manifest);
  return [
    step("preflight", "校验上一版本、回滚 manifest、备份与 D1 双版本兼容", false, [
      command("git", ["cat-file", "-e", `${manifest.sourceCommit}^{commit}`]),
      command("kubectl", ["config", "get-contexts", manifest.sealos.context, "-o", "name"]),
      command("npm", ["exec", "--workspace", "@inbox/api", "--", "wrangler", "d1", "migrations", "list", manifest.cloudflare.database.name, "--remote"]),
    ]),
    step("api", "API 回退到上一 Cloudflare version", true, [
      command("npm", ["exec", "--workspace", "@inbox/api", "--", "wrangler", "versions", "deploy", `${manifest.cloudflare.api.previousVersion}@100%`, "--name", manifest.cloudflare.api.name, "--yes"]),
    ]),
    step("console", "Console 重新部署上一不可变产物", true, [
      command("npm", ["exec", "--workspace", "@inbox/console", "--", "wrangler", "pages", "deploy", manifest.cloudflare.console.previousArtifactDir, "--project-name", manifest.cloudflare.console.projectName, "--branch", manifest.cloudflare.console.branch, "--commit-hash", manifest.cloudflare.console.previousCommit, "--commit-dirty=false"]),
    ]),
    step("worker", "Worker 回退上一三容器 digest manifest", true, [
      command("kubectl", [...kubectl, "apply", "-f", manifest.sealos.rollbackManifestPath]),
      command("kubectl", [...kubectl, "rollout", "status", `statefulset/${manifest.sealos.workloadName}`]),
    ]),
    step("stability-window", "验证回滚后的健康、积压与 D1 兼容", false, [
      command("npm", [
        "run", "verify:live", "--workspace", "@inbox/api", "--",
        "--health-url", manifest.exitGate.apiHealthUrl,
        "--stability-seconds", String(manifest.exitGate.stabilitySeconds),
      ]),
    ]),
  ];
}

function step(
  id: string,
  description: string,
  mutates: boolean,
  commands: readonly ReleaseCommand[] = [],
  rollbackCommands: readonly ReleaseCommand[] = [],
): ReleaseStep {
  return { commands, description, id, mutates, rollbackCommands };
}

function command(file: string, args: readonly string[]): ReleaseCommand {
  return { args, file };
}

function kubectlPrefix(manifest: ReleaseManifest): readonly string[] {
  return ["--context", manifest.sealos.context, "--namespace", manifest.sealos.namespace];
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} 包含未允许字段: ${unexpected.join(",")}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} 必须是非空字符串`);
  return value;
}

function commit(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!commitPattern.test(parsed)) throw new Error(`${path} 必须是 40 位提交 SHA`);
  return parsed;
}

function timestamp(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${path} 必须是 RFC 3339 时间`);
  return parsed;
}

function safePath(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (parsed.startsWith("/") || parsed.split("/").includes("..")) {
    throw new Error(`${path} 必须是仓库内相对路径`);
  }
  return parsed;
}

function httpsUrl(value: unknown, path: string): string {
  const parsed = new URL(text(value, path));
  if (parsed.protocol !== "https:") throw new Error(`${path} 必须使用 HTTPS`);
  return parsed.toString();
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${path} 必须是正整数`);
  return Number(value);
}

function kubeContext(value: unknown): string {
  const parsed = text(value, "sealos.context");
  if (/orbstack|docker-desktop|minikube/i.test(parsed)) {
    throw new Error("sealos.context 禁止指向本机 Kubernetes context");
  }
  return parsed;
}

function imageVersions(value: unknown, path: string): { previous: string; target: string } {
  const parsed = record(value, path);
  exactKeys(parsed, ["previous", "target"], path);
  const previous = text(parsed.previous, `${path}.previous`);
  const target = text(parsed.target, `${path}.target`);
  if (!digestPattern.test(previous) || !digestPattern.test(target)) {
    throw new Error(`${path} 必须使用南京大学 GHCR 代理的 sha256 digest`);
  }
  return { previous, target };
}

function rejectSensitiveMaterial(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectSensitiveMaterial(child, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "secrets" && /authorization|cookie|credential|password|secret|token|value/i.test(key)) {
      throw new Error(`${path}.${key} 禁止保存敏感原值，只允许 Secret 版本引用`);
    }
    rejectSensitiveMaterial(child, `${path}.${key}`);
  }
}

function migrationList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("database.migrations 不能为空");
  const parsed = value.map((item, index) => safePath(item, `database.migrations[${index}]`));
  if (parsed.some((item) => !/^apps\/api\/migrations\/\d{4}_[a-z0-9_-]+\.sql$/.test(item))) {
    throw new Error("database.migrations 只能引用 apps/api/migrations 下的编号 SQL");
  }
  if (new Set(parsed).size !== parsed.length) throw new Error("database.migrations 不得重复");
  return parsed;
}

function secretRefs(value: unknown): readonly { name: string; versionRef: string }[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("secrets 不能为空");
  return value.map((item, index) => {
    const parsed = record(item, `secrets[${index}]`);
    exactKeys(parsed, ["name", "versionRef"], `secrets[${index}]`);
    return {
      name: text(parsed.name, `secrets[${index}].name`),
      versionRef: text(parsed.versionRef, `secrets[${index}].versionRef`),
    };
  });
}
