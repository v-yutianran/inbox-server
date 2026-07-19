import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { API_KEY_STORAGE } from "./api";
import { App } from "./App";

const overview = {
  status: "ok",
  generated_at: "2026-07-19T06:30:00+00:00",
  server: { online: true },
  worker: { online: true, last_heartbeat_at: "2026-07-19T06:29:50+00:00" },
  scheduler: { enabled: true, interval_seconds: 600, next_run_at: null },
  channels: { sources: {}, destinations: {} },
  queues: {
    link: { pending: 0, dlq: 0, done: 3 },
    text: { pending: 0, dlq: 0, done: 1 },
    file: { pending: 0, dlq: 0, done: 0 },
    article: { pending: 0, dlq: 0, done: 2 },
  },
  sync_jobs: [],
  article_events: [],
};

test("没有会话 API Key 时只显示解锁界面", () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");

  render(<App />);

  expect(screen.getByRole("heading", { name: "连接控制台" })).toBeInTheDocument();
  expect(screen.getByLabelText("管理 API Key")).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("有效 API Key 仅写入 sessionStorage 并加载汇总", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(overview), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const user = userEvent.setup();
  render(<App />);

  await user.type(screen.getByLabelText("管理 API Key"), "secret-key");
  await user.click(screen.getByRole("button", { name: "进入控制台" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/operations/overview",
    expect.objectContaining({ headers: { "X-API-Key": "secret-key" } }),
  );
  expect(sessionStorage.getItem(API_KEY_STORAGE)).toBe("secret-key");
  expect(screen.getByText("运行总览")).toBeInTheDocument();
});

test("控制台展示服务、队列、渠道和两类历史", async () => {
  sessionStorage.setItem(API_KEY_STORAGE, "secret-key");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        ...overview,
        channels: {
          sources: { telegram: { enabled: true, kind: "api" } },
          destinations: { cubox: { enabled: true, item_kind: "link" } },
        },
        queues: {
          ...overview.queues,
          link: { pending: 4, dlq: 1, done: 42 },
        },
        sync_jobs: [
          {
            id: "job-1",
            triggered_by: "manual",
            status: "done",
            stats: { telegram: { enqueued: { link: 2 } } },
            started_at: "2026-07-19T06:20:00+00:00",
            finished_at: "2026-07-19T06:20:02+00:00",
            error: null,
          },
        ],
        article_events: [
          {
            id: 1,
            source_url: "https://example.com/article",
            url_fingerprint: "0123456789",
            title: "一篇示例文章",
            status: "committed",
            reason: null,
            filename: "20260719-一篇示例文章.md",
            occurred_at: "2026-07-19T06:21:00+00:00",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  render(<App />);

  expect(await screen.findByText("运行总览")).toBeInTheDocument();
  expect(screen.getByText("服务在线")).toBeInTheDocument();
  expect(screen.getByText("Worker 在线")).toBeInTheDocument();
  expect(screen.getByText("每 10 分钟")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Link 队列" })).toBeInTheDocument();
  expect(screen.getByText("telegram")).toBeInTheDocument();
  expect(screen.getByText("cubox")).toBeInTheDocument();
  expect(screen.getByText("手动触发")).toBeInTheDocument();
  expect(screen.getByText("一篇示例文章")).toBeInTheDocument();
  expect(screen.getByText("已归档并推送")).toBeInTheDocument();
});

test("手动同步完成后刷新汇总并提供反馈", async () => {
  sessionStorage.setItem(API_KEY_STORAGE, "secret-key");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/sync" && init?.method === "POST") {
      return new Response(JSON.stringify({ status: "ok", results: {} }), { status: 200 });
    }
    return new Response(JSON.stringify(overview), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("运行总览");

  await user.click(screen.getByRole("button", { name: "立即同步" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/sync",
      expect.objectContaining({
        method: "POST",
        headers: { "X-API-Key": "secret-key" },
      }),
    );
  });
  expect(await screen.findByText("同步完成，运行状态已刷新")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("汇总加载失败时显示错误和重试入口", async () => {
  sessionStorage.setItem(API_KEY_STORAGE, "secret-key");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent("请求失败（503）");
  expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
});
