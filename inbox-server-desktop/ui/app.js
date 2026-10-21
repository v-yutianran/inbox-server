const notice = document.querySelector("#notice");
const stats = document.querySelector("#stats");
const items = document.querySelector("#items");
const syncJobs = document.querySelector("#sync-jobs");
const history = document.querySelector("#history");
const dataDir = document.querySelector("#data-dir");
const nextRun = document.querySelector("#next-run");
const settingsMeta = document.querySelector("#settings-meta");
const captureForm = document.querySelector("#capture");
const settingsForm = document.querySelector("#settings");
const importForm = document.querySelector("#import");
const kindSelect = captureForm.itemKind;

kindSelect.addEventListener("change", updateComposer);
updateComposer();

document.querySelector("#refresh").addEventListener("click", () => void load());
document.querySelector("#sync").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    const result = await post("/api/sync", {});
    show(result.error ? `同步结束，但有错误：${result.error}` : "同步完成");
    await load();
  } catch (error) {
    show(error.message);
  } finally {
    event.currentTarget.disabled = false;
  }
});

captureForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(captureForm);
  const itemKind = String(form.get("itemKind"));
  const body = { itemKind, title: String(form.get("title") || "") };
  if (itemKind === "text") body.content = String(form.get("content") || "");
  else if (itemKind === "file") body.localPath = String(form.get("localPath") || "");
  else body.url = String(form.get("url") || "");
  try {
    const result = await post("/api/capture", body);
    show(result.duplicate ? "这条已经在收件匣里" : `已收录，状态 ${result.status}`);
    captureForm.reset();
    updateComposer();
    await load();
  } catch (error) {
    show(error.message);
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(settingsForm);
  const optional = (name) => {
    const value = String(form.get(name) || "").trim();
    return value.length > 0 ? value : undefined;
  };
  const body = {
    archiveEnabled: form.get("archiveEnabled") === "on",
    schedulerEnabled: form.get("schedulerEnabled") === "on",
    intervalSeconds: Number(form.get("intervalSeconds")),
    sources: {
      dida: { enabled: form.get("didaEnabled") === "on", accessToken: optional("didaToken") },
      github_stars: { enabled: form.get("githubEnabled") === "on", token: optional("githubToken") },
      telegram: { enabled: form.get("telegramEnabled") === "on", botToken: optional("telegramToken") },
    },
    forward: {
      cuboxUrl: optional("cuboxUrl"),
      flomoWebhook: optional("flomoWebhook"),
    },
  };
  try {
    await post("/api/settings", body);
    settingsForm.querySelectorAll("input[type=password], input[type=url]").forEach((input) => {
      input.value = "";
    });
    show("设置已保存在本机");
    await load();
  } catch (error) {
    show(error.message);
  }
});

importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = JSON.parse(String(new FormData(importForm).get("payload") || ""));
    const summary = await post("/api/import", payload);
    show(`导入完成：归档 ${summary.articleEvents}，状态 ${summary.stateKeys}，历史任务 ${summary.cloudJobs}，重新入队 ${summary.requeued}，跳过密文 ${summary.skippedEncryptedEnvelopes}`);
    await load();
  } catch (error) {
    show(error.message);
  }
});

await load();

function updateComposer() {
  const kind = kindSelect.value;
  document.querySelector("#url-field").hidden = kind === "text" || kind === "file";
  document.querySelector("#content-field").hidden = kind !== "text";
  document.querySelector("#file-field").hidden = kind !== "file";
}

async function load() {
  const overview = await getJson("/api/overview");
  renderStats(overview.queues);
  renderItems(overview.items);
  renderRecords(syncJobs, overview.syncJobs, (job) => `${job.startedAt} · ${job.triggeredBy} · ${job.status}${job.error ? ` · ${job.error}` : ""}`);
  renderRecords(history, overview.cloudHistory, (row) => `${row.createdAt} · ${row.itemKind || row.kind} · ${row.status}`);
  dataDir.textContent = overview.dataDir;
  nextRun.textContent = overview.scheduler.nextRunAt ? `下次同步 ${overview.scheduler.nextRunAt}` : "定时同步已关闭";
  settingsForm.archiveEnabled.checked = overview.settings.archiveEnabled;
  settingsForm.schedulerEnabled.checked = overview.settings.schedulerEnabled;
  settingsForm.intervalSeconds.value = String(overview.settings.intervalSeconds);
  settingsForm.didaEnabled.checked = overview.settings.sources.dida.enabled;
  settingsForm.githubEnabled.checked = overview.settings.sources.github_stars.enabled;
  settingsForm.telegramEnabled.checked = overview.settings.sources.telegram.enabled;
  const configured = [
    overview.settings.sources.dida.accessTokenSet ? "滴答 token 已保存" : "",
    overview.settings.sources.github_stars.tokenSet ? "GitHub token 已保存" : "",
    overview.settings.sources.telegram.botTokenSet ? "Telegram token 已保存" : "",
    overview.settings.forward.cuboxUrlSet ? "Cubox 已配置" : "",
    overview.settings.forward.flomoWebhookSet ? "flomo 已配置" : "",
  ].filter(Boolean);
  settingsMeta.textContent = configured.join(" · ") || "还没有保存第三方凭据";
}

function renderStats(queues) {
  stats.replaceChildren();
  for (const kind of ["link", "text", "file", "article"]) {
    const counts = queues[kind];
    const card = document.createElement("div");
    card.className = "stat";
    const strong = document.createElement("strong");
    strong.textContent = String(counts.pending + counts.deferred);
    const span = document.createElement("span");
    span.textContent = `${label(kind)} 待处理 · 完成 ${counts.done} · 失败 ${counts.dead}`;
    card.append(strong, span);
    stats.append(card);
  }
}

function renderItems(rows) {
  items.replaceChildren();
  if (rows.length === 0) {
    items.append(paragraph("收件匣是空的。贴一条链接，或打开滴答 / GitHub / Telegram 同步。"));
    return;
  }
  for (const row of rows) {
    const article = document.createElement("article");
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = row.title || row.content || row.url || row.itemKind;
    const meta = document.createElement("div");
    meta.className = "meta";
    const pill = document.createElement("span");
    pill.className = `pill ${row.status}`;
    pill.textContent = `${label(row.itemKind)} · ${row.status}`;
    meta.append(pill, document.createTextNode(` ${row.source} · ${row.createdAt}`));
    article.append(title, meta);
    if (row.url) {
      const link = document.createElement("a");
      link.href = row.url;
      link.textContent = row.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      article.append(link);
    }
    if (row.destinationPath) {
      const path = document.createElement("div");
      path.className = "meta";
      path.textContent = row.destinationPath;
      article.append(path);
    }
    items.append(article);
  }
}

function renderRecords(container, rows, format) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(paragraph("暂无"));
    return;
  }
  for (const row of rows.slice(0, 8)) {
    const line = document.createElement("div");
    line.className = "record";
    line.textContent = format(row);
    container.append(line);
  }
}

function paragraph(text) {
  const node = document.createElement("p");
  node.className = "meta";
  node.textContent = text;
  return node;
}

function label(kind) {
  return { link: "链接", text: "文本", file: "文件", article: "文章" }[kind] || kind;
}

function show(message) {
  notice.hidden = false;
  notice.textContent = message;
}

async function getJson(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

async function post(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}
