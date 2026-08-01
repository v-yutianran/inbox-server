import { describe, expect, it, vi } from "vitest";

import {
  createPagesPreviewDeploymentPlan,
  executePagesPreviewDeployment,
  type PagesDeploymentPorts,
} from "../scripts/pages-deployment";

describe("Cloudflare Pages Preview 部署门禁", () => {
  it("固定项目、功能分支、提交和 API URL", () => {
    expect(
      createPagesPreviewDeploymentPlan(
        {
          branch: "feat/cloudflare-console-server-deploy",
          commitHash: "abc1234",
          dirty: false,
        },
        "https://inbox-server-api.example.workers.dev",
      ),
    ).toEqual({
      apiUrl: "https://inbox-server-api.example.workers.dev",
      build: { command: "npm", args: ["run", "build"] },
      deploy: {
        command: "wrangler",
        args: [
          "pages",
          "deploy",
          "dist",
          "--project-name",
          "inbox-server-console",
          "--branch",
          "feat/cloudflare-console-server-deploy",
          "--commit-hash",
          "abc1234",
          "--commit-dirty=false",
        ],
      },
      environment: "preview",
    });
  });

  it.each([
    ["main", false, "生产分支 main"],
    ["", false, "detached HEAD"],
    ["feature/example", true, "工作区存在未提交变更"],
  ])("拒绝不安全的部署上下文 %j", (branch, dirty, expectedMessage) => {
    expect(() =>
      createPagesPreviewDeploymentPlan(
        { branch, commitHash: "abc1234", dirty },
        "https://inbox-server-api.example.workers.dev",
      ),
    ).toThrow(expectedMessage);
  });

  it("dry-run 只输出构建和部署计划", () => {
    const ports = createPorts();

    executePagesPreviewDeployment(
      {
        apiUrl: "https://inbox-server-api.example.workers.dev",
        dryRun: true,
      },
      ports,
    );

    expect(ports.run).not.toHaveBeenCalled();
    expect(ports.log).toHaveBeenCalledTimes(2);
  });
});

function createPorts(): PagesDeploymentPorts {
  return {
    inspectGit: vi.fn(() => ({
      branch: "feature/example",
      commitHash: "abc1234",
      dirty: false,
    })),
    run: vi.fn<PagesDeploymentPorts["run"]>(),
    log: vi.fn<PagesDeploymentPorts["log"]>(),
  };
}
