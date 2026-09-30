import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { runBrowserBatch } from "../apps/worker/src/browser";

if (process.argv.includes("--dry-run")) {
  console.log("预检：三个隔离会话；合成页面；成功、失败、60 秒断线兜底；不处理业务任务。");
} else {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert(account && token, "需要受保护的 Cloudflare E2E 凭据");
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/browser-run/devtools/browser`;
  const headers = { Authorization: `Bearer ${token}` };
  for (const scenario of ["success", "failure", "idle"] as const) {
    const acquired = await fetch(`${base}?keep_alive=60000`, { method: "POST", headers });
    assert.equal(acquired.status, 200, "无法创建隔离会话");
    const { sessionId, webSocketDebuggerUrl } = await acquired.json();
    assert(sessionId && webSocketDebuggerUrl, "缺少会话标识");
    try {
      const browser = await chromium.connectOverCDP(webSocketDebuggerUrl, { headers, timeout: 30_000 });
      const started = Date.now();
      if (scenario === "idle") {
        await browser.close();
        await setTimeout(75_000);
      } else {
        const batch = runBrowserBatch(true, async () => browser, async (connected) => {
          const page = await connected!.newPage();
          await page.setContent("<title>Browser lifecycle E2E</title>");
          assert.equal(await page.title(), "Browser lifecycle E2E");
          if (scenario === "failure") throw new Error("synthetic batch failure");
          return "settled";
        });
        if (scenario === "failure") await assert.rejects(batch, /synthetic batch failure/);
        else assert.equal(await batch, "settled");
        assert.equal(browser.isConnected(), false);
      }
      const probe = await fetch(`${base}/${sessionId}/json/list`, { headers });
      assert([404, 410].includes(probe.status), "远程会话仍存在");
      console.log(JSON.stringify({ scenario, sessionId, elapsedMs: Date.now() - started, closed: true }));
    } finally {
      await fetch(`${base}/${sessionId}`, { method: "DELETE", headers });
    }
  }
}
