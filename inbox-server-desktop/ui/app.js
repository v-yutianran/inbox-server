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
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await post("/api/sync", {});
    show(result.error ? `同步结束，但有错误：${result.error}` : "同步完成");
    await load();
  } catch (error) {
    show(error.message);
  } finally {
    button.disabled = false;
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

for (const row of document.querySelectorAll(".login-row")) {
  const platform = row.dataset.platform;
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = platform === "zhihu" ? "粘贴 z_c0" : platform === "bilibili" ? "粘贴 SESSDATA" : "粘贴 storageState JSON";
  input.autocomplete = "off";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "保存登录";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "ghost";
  open.textContent = "窗口登录";
  save.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) {
      show("先粘贴 cookie 或 storageState");
      return;
    }
    let payload = { storageState: value };
    if (platform === "zhihu") payload = { z_c0: value };
    else if (platform === "bilibili") payload = { sessdata: value };
    else {
      try {
        payload = { storageState: JSON.parse(value) };
      } catch {
        show("storageState 需要是 JSON");
        return;
      }
    }
    try {
      const result = await post(`/api/profiles/${platform}`, payload);
      input.value = "";
      show(`${platform} 已保存 ${result.cookies} 个 cookie`);
      await load();
    } catch (error) {
      show(error.message);
    }
  });
  open.addEventListener("click", async () => {
    open.disabled = true;
    try {
      const result = await post(`/api/login/${platform}`, {});
      show(`${platform} 登录窗口已关闭，保存了 ${result.cookies} 个 cookie`);
      await load();
    } catch (error) {
      show(error.message);
    } finally {
      open.disabled = false;
    }
  });
  row.append(input, save, open);
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(settingsForm);
  const optional = (name) => {
    const value = String(form.get(name) || "").trim();
    return value.length > 0 ? value : undefined;
  };
  const visible = (name) => {
    const value = String(form.get(name) || "").trim();
    return value.length > 0 ? value : null;
  };
  const body = {
    archiveEnabled: form.get("archiveEnabled") === "on",
    archiveGit: form.get("archiveGit") === "on",
    schedulerEnabled: form.get("schedulerEnabled") === "on",
    intervalSeconds: Number(form.get("intervalSeconds")),
    sources: {
      dida: { enabled: form.get("didaEnabled") === "on", accessToken: optional("didaToken") },
      github_stars: { enabled: form.get("githubEnabled") === "on", token: optional("githubToken") },
      telegram: { enabled: form.get("telegramEnabled") === "on", botToken: optional("telegramToken") },
      zhihu: { enabled: form.get("zhihuEnabled") === "on", collectionId: visible("zhihuCollectionId") },
      bilibili: { enabled: form.get("bilibiliEnabled") === "on", mediaId: visible("bilibiliMediaId") },
      bilibili_toview: { enabled: form.get("bilibiliToviewEnabled") === "on" },
      inoreader: { enabled: form.get("inoreaderEnabled") === "on" },
      youtube: { enabled: form.get("youtubeEnabled") === "on" },
      x_bookmarks: { enabled: form.get("xBookmarksEnabled") === "on" },
      x_likes: { enabled: form.get("xLikesEnabled") === "on", username: visible("xUsername") },
    },
    forward: {
      cuboxUrl: optional("cuboxUrl"),
      flomoWebhook: optional("flomoWebhook"),
    },
    jianguoyun: {
      enabled: form.get("jianguoyunEnabled") === "on",
      baseUrl: visible("jianguoyunBaseUrl"),
      user: optional("jianguoyunUser"),
      password: optional("jianguoyunPassword"),
    },
    notification: {
      telegramChatId: visible("telegramChatId"),
      notifyToken: optional("notifyToken"),
      emailEnabled: form.get("emailEnabled") === "on",
      smtpHost: visible("smtpHost"),
      smtpPort: Number(form.get("smtpPort")) || undefined,
      smtpUser: optional("smtpUser"),
      smtpPass: optional("smtpPass"),
      emailFrom: visible("emailFrom"),
      emailTo: visible("emailTo"),
    },
    ima: {
      enabled: form.get("imaEnabled") === "on",
      knowledgeBaseName: visible("imaKnowledgeBaseName"),
      apiKey: optional("imaApiKey"),
      clientId: optional("imaClientId"),
      webKnowledgeBaseId: visible("imaWebKnowledgeBaseId"),
      webCookie: optional("imaWebCookie"),
      webImaCookie: optional("imaWebImaCookie"),
      webBkn: optional("imaWebBkn"),
    },
    llm: {
      model: visible("llmModel"),
      apiKey: optional("llmApiKey"),
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
  const settings = overview.settings;
  settingsForm.archiveEnabled.checked = settings.archiveEnabled;
  settingsForm.archiveGit.checked = settings.archiveGit;
  settingsForm.schedulerEnabled.checked = settings.schedulerEnabled;
  settingsForm.intervalSeconds.value = String(settings.intervalSeconds);
  settingsForm.didaEnabled.checked = settings.sources.dida.enabled;
  settingsForm.githubEnabled.checked = settings.sources.github_stars.enabled;
  settingsForm.telegramEnabled.checked = settings.sources.telegram.enabled;
  settingsForm.zhihuEnabled.checked = settings.sources.zhihu.enabled;
  settingsForm.zhihuCollectionId.value = settings.sources.zhihu.collectionId;
  settingsForm.bilibiliEnabled.checked = settings.sources.bilibili.enabled;
  settingsForm.bilibiliMediaId.value = settings.sources.bilibili.mediaId;
  settingsForm.bilibiliToviewEnabled.checked = settings.sources.bilibili_toview.enabled;
  settingsForm.inoreaderEnabled.checked = settings.sources.inoreader.enabled;
  settingsForm.youtubeEnabled.checked = settings.sources.youtube.enabled;
  settingsForm.xBookmarksEnabled.checked = settings.sources.x_bookmarks.enabled;
  settingsForm.xLikesEnabled.checked = settings.sources.x_likes.enabled;
  settingsForm.xUsername.value = settings.sources.x_likes.username;
  settingsForm.jianguoyunEnabled.checked = settings.jianguoyun.enabled;
  settingsForm.jianguoyunBaseUrl.value = settings.jianguoyun.baseUrl;
  settingsForm.emailEnabled.checked = settings.notification.emailEnabled;
  settingsForm.telegramChatId.value = settings.notification.telegramChatId;
  settingsForm.smtpHost.value = settings.notification.smtpHost;
  settingsForm.smtpPort.value = String(settings.notification.smtpPort);
  settingsForm.emailFrom.value = settings.notification.emailFrom;
  settingsForm.emailTo.value = settings.notification.emailTo;
  settingsForm.imaEnabled.checked = settings.ima.enabled;
  settingsForm.imaKnowledgeBaseName.value = settings.ima.knowledgeBaseName;
  settingsForm.imaWebKnowledgeBaseId.value = settings.ima.webKnowledgeBaseId;
  settingsForm.llmModel.value = settings.llm.model;
  const configured = [
    settings.sources.dida.accessTokenSet ? "滴答 token 已保存" : "",
    settings.sources.github_stars.tokenSet ? "GitHub token 已保存" : "",
    settings.sources.telegram.botTokenSet ? "Telegram token 已保存" : "",
    settings.forward.cuboxUrlSet ? "Cubox 已配置" : "",
    settings.forward.flomoWebhookSet ? "flomo 已配置" : "",
    settings.jianguoyun.userSet ? "坚果云账号已保存" : "",
    settings.notification.notifyTokenSet ? "通知 token 已保存" : "",
    settings.notification.smtpPassSet ? "SMTP 授权码已保存" : "",
    settings.ima.apiKeySet ? "ima key 已保存" : "",
    settings.llm.apiKeySet ? "智谱 key 已保存" : "",
    ...(overview.profiles || []).filter((profile) => profile.saved).map((profile) => `${profile.platform} 登录 ${profile.cookieCount} 个 cookie`),
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
