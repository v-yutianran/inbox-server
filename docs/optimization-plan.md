# inbox-server 优化计划

> 基于 Effective Python(90 items) + Clean Code + DDD + Data-Intensive Patterns + Using Asyncio 综合审查。

> ⚠️ **本文档状态已严重滞后（写于 2026-06-27）**：P0 全部、P1 大部分（P1-3/4/5）已在 2026-06-28 代码中实现，但未回写本文档。
> 当前进度以 [`roadmap.md`](../roadmap.md) 为准（每项 `[x]` 附 `文件:行号` 证据）。本文档保留为历史审查记录，**勿直接引用其状态判断**。

## 肯定的好模式(inbox-server 已做对)

| 模式 | Effective Python Item | 体现 |
|------|----------------------|------|
| `@dataclass` 数据持有 | Items 37–43 | Bookmark/QueueItem/CollectResult/RetryDecision |
| 类型注解 + Protocol | Item 84 | 全部 public 函数 + runtime_checkable Protocol |
| 中文 docstring | Item 84 | 每个函数解释 WHY |
| `asyncio` 并发 IO | Item 60 | consumer/orchestrator/scheduler 全 async |
| `asyncio.to_thread` 包阻塞调用 | Item 62 | email_notifier subprocess + jianguoyun webdav |
| `unittest.mock.AsyncMock` | Item 78 | 112 测试全 mock |
| `@dataclass(frozen=True)` 不可变 | Item 37 | RetryDecision（决策结果不可变） |
| 异常代替 None 返回 | Item 20 | vault raise ValueError / scraper raise LoginExpired |

**结论:inbox-server 代码整体是 idiomatic Python,基础扎实。** 以下是进一步优化空间。

---

## 优化项（按优先级）

### P0 — Critical(正确性)

#### 1. consumer 缺少 graceful shutdown(Item 60)
**现状**: `consumer.consume` 是 `while True` 无限循环,`runner.run_worker` 的 `asyncio.gather` 无法优雅关停(SIGTERM/SIGINT 时强杀,可能丢失 in-flight item)。

**修复**: 加 `asyncio.Event` 停止信号 + runner signal handler:
```python
# workers/runner.py
stop_event = asyncio.Event()

async def run_worker():
    ...
    tasks = [consume(..., stop_event) for kind in dests]
    # 注册信号
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)
    await asyncio.gather(*tasks)

# workers/consumer.py
async def consume(..., stop_event):
    while not stop_event.is_set():
        ...
    print(f"[worker] {name} graceful shutdown")
```

#### 2. BrowserPool context 生命周期无上限(内存泄漏风险)
**现状**: `BrowserPool._contexts` 按 platform 缓存 context,永不释放。长期运行(7×24 worker)累积内存。

**修复**: 加 LRU/最大 context 数 + 定期关闭 idle context:
```python
class BrowserPool:
    MAX_CONTEXTS = 10

    async def context_for(self, platform, storage_state):
        if len(self._contexts) >= self.MAX_CONTEXTS:
            # 关闭最旧的
            oldest = next(iter(self._contexts))
            await self._contexts.pop(oldest).close()
        ...
```

---

### P1 — Important(可维护性)

#### 3. orchestrator `_collect_browser_sources` 过长(SRP 违反,Clean Code)
**现状**: 该函数 ~80 行(import + 创建依赖 + 4 源 collect 循环)。

**修复**: 拆分为:
- `_create_browser_deps(channels, session)` → 返回(session_manager, baseline_repo, llm_key)
- `_collect_one_source(name, cls, deps, mode)` → 单源 collect
- `_collect_browser_sources` 编排(调用上面)

#### 4. parse_netscape_bookmarks 用 list 而非 generator(Item 30)
**现状**: 返回 `list[Bookmark]`,大书签(inoreader 1081 条)一次性加载内存。

**修复**: 改 generator(`yield Bookmark`),consumer 增量处理:
```python
def parse_netscape_bookmarks(html_text) -> Iterator[Bookmark]:
    for m in _BOOKMARK_RE.finditer(html_text):
        ...
        yield Bookmark(url=url, title=title)
```

#### 5. `@contextmanager` 封装 browser lifecycle(Item 66)
**现状**: `playwright_runtime.get_browser/shutdown` 手动管理,调用方需配对。

**修复**: `@asynccontextmanager` 统一 lifecycle:
```python
@asynccontextmanager
async def browser_session():
    browser = await get_browser()
    try:
        yield browser
    finally:
        await shutdown()
```

#### 6. channels config 校验不完整(Pydantic 未充分利用)
**现状**: `ChannelsConfig` 是 dataclass,`ChannelEntry.config` 是 `dict`(无类型约束)。`required_config` 只在注释声明,运行时不校验。

**修复**: ChannelEntry.config 用 Pydantic 模型(按 source 类型):
```python
class TelegramConfig(BaseModel):
    bot_token: str
class ZhihuConfig(BaseModel):
    credential_name: str
    collection_id: str
```
启动时 fail-fast(缺字段报错)。

---

### P2 — Suggestion(打磨)

#### 7. consumer `consume` 参数过多(Item 25 keyword-only)
**现状**: `consume(kind, queue_repo, dedup_store, rate_guard, process_fn, name, *, window_count, window_sec, daily_limit, interval)` — 10+ 参数。

**修复**: 用 dataclass 封装限额参数:
```python
@dataclass
class QueueLimits:
    window_count: int
    window_sec: int
    daily_limit: int | None
    interval: float

async def consume(kind, *, deps: ConsumeDeps, limits: QueueLimits): ...
```

#### 8. 测试用 `wait_for` 超时取消(Item 78 可靠性)
**现状**: `test_worker_consume` 用 `asyncio.wait_for(consume(...), timeout)` 超时取消,但取消时 in-flight item 可能半处理。

**修复**: 加 `stop_event` 到 consumer(配合 P0-1),测试 `stop_event.set()` 精确停止,不用 wait_for 暴力取消。

#### 9. structlog bind context(structlog 最佳实践)
**现状**: structlog 全局 logger,但无 context binding(source/queue 等上下文丢失)。

**修复**: 关键路径 `structlog.contextvars.bind_contextvars(platform=..., queue=...)`:
```python
# consumer
structlog.contextvars.bind_contextvars(kind=kind.value)
log.info("consume_result", ...)
```

#### 10. 增加类型检查门槩(mypy/pyright)
**现状**: 有 ruff(lint)无 type checker。Protocol/type hint 没有静态验证。

**修复**: 加 mypy 或 pyright 到 CI:
```yaml
# .github/workflows/ci.yml
- run: uv run mypy src/inboxserver
```

---

## 优化路线图

| 阶段 | 项 | 预估 | 价值 |
|------|-----|------|------|
| **第一阶段** | P0-1 graceful shutdown + P0-2 BrowserPool 上限 | 2h | 生产稳定性 |
| **第二阶段** | P1-3 orchestrator 拆分 + P1-6 Pydantic config | 3h | 可维护性 |
| **第三阶段** | P1-4 generator + P1-5 contextmanager | 2h | 内存/资源 |
| **第四阶段** | P2-7~10 打磨 | 3h | 工程质量 |

**总计 ~10h**,分 4 个 PR。每项有测试验证(TDD),改完跑 `pytest tests/unit tests/integration` 全绿。
