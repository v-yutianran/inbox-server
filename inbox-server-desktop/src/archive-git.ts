import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 把归档目录初始化成只属于本机的 Git 仓库，不配置远程。 */
export async function commitArchiveFile(repoDir: string, relativePath: string): Promise<void> {
  const git = async (...args: string[]) => {
    await execFileAsync("git", ["-c", `safe.directory=${repoDir}`, "-C", repoDir, ...args]);
  };
  await git("init");
  await git("config", "user.email", "inbox@localhost");
  await git("config", "user.name", "inbox-desktop");
  await git("config", "commit.gpgsign", "false");
  await git("add", "--", relativePath);
  try {
    await git("commit", "-m", `archive ${relativePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("nothing to commit") && !message.includes("clean")) throw error;
  }
}
