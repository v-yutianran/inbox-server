import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { importCloudExport } from "../src/import-cloud.ts";
import { resolveDataDir } from "../src/paths.ts";
import { InboxStore } from "../src/store.ts";

const file = process.argv[2];
if (!file) {
  console.error("用法: npm run import -- ./cloud-export.json");
  process.exit(1);
}

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new InboxStore(join(dataDir, "inbox.sqlite"));
try {
  const payload: unknown = JSON.parse(readFileSync(file, "utf8"));
  console.log(JSON.stringify(importCloudExport(store, payload), null, 2));
} finally {
  store.close();
}
