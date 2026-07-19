import { useCallback, useEffect, useState } from "react";

import { ApiError, clearApiKey, fetchOverview, readApiKey, triggerSync, writeApiKey } from "./api";
import { Dashboard } from "./components/Dashboard";
import type { OperationsOverview } from "./types";

type UnlockProps = {
  onUnlock: (apiKey: string) => void;
};

function Unlock({ onUnlock }: UnlockProps) {
  const [value, setValue] = useState("");

  return (
    <main className="unlock-shell">
      <section className="unlock-card" aria-labelledby="unlock-title">
        <p className="eyebrow">INBOX / OPERATIONS</p>
        <h1 id="unlock-title">连接控制台</h1>
        <p>管理密钥只保存在当前浏览器会话，关闭标签页后自动清除。</p>
        <form className="unlock-form"
          onSubmit={(event) => {
            event.preventDefault();
            const apiKey = value.trim();
            if (apiKey) onUnlock(apiKey);
          }}
        >
          <label htmlFor="api-key">管理 API Key</label>
          <input
            id="api-key"
            type="password"
            value={value}
            autoComplete="current-password"
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit">进入控制台</button>
        </form>
      </section>
    </main>
  );
}

function ErrorState({ message, onRetry, onLock }: { message: string; onRetry: () => void; onLock: () => void }) {
  return (
    <main className="unlock-shell">
      <section className="unlock-card error-card">
        <span className="error-code">CONNECTION / ERROR</span>
        <h1>状态暂时不可用</h1>
        <p role="alert">{message}</p>
        <div className="error-actions">
          <button className="button button--signal" type="button" onClick={onRetry}>重新加载</button>
          <button className="button" type="button" onClick={onLock}>更换 API Key</button>
        </div>
      </section>
    </main>
  );
}

export function App() {
  const [apiKey, setApiKey] = useState(readApiKey);
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const lock = useCallback(() => {
    clearApiKey();
    setApiKey("");
    setOverview(null);
    setError(null);
    setNotice(null);
  }, []);

  const loadOverview = useCallback(async () => {
    if (!apiKey) return;
    setRefreshing(true);
    setError(null);
    try {
      setOverview(await fetchOverview(apiKey));
    } catch (reason: unknown) {
      if (reason instanceof ApiError && reason.status === 401) {
        lock();
        return;
      }
      setError(reason instanceof Error ? reason.message : "无法加载运行状态");
    } finally {
      setRefreshing(false);
    }
  }, [apiKey, lock]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  if (!apiKey) {
    return (
      <Unlock
        onUnlock={(value) => {
          writeApiKey(value);
          setApiKey(value);
        }}
      />
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => void loadOverview()} onLock={lock} />;
  if (!overview) return <main><p role="status">正在加载运行状态…</p></main>;

  return (
    <Dashboard
      overview={overview}
      refreshing={refreshing}
      syncing={syncing}
      notice={notice}
      onRefresh={() => void loadOverview()}
      onSync={() => {
        setSyncing(true);
        setNotice(null);
        void triggerSync(apiKey)
          .then(loadOverview)
          .then(() => setNotice("同步完成，运行状态已刷新"))
          .catch((reason: unknown) => {
            if (reason instanceof ApiError && reason.status === 401) lock();
            else setError(reason instanceof Error ? reason.message : "同步失败");
          })
          .finally(() => setSyncing(false));
      }}
      onLock={lock}
    />
  );
}
