import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeEvidenceFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}
