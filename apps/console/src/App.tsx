import { useCallback, useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";

import {
  ApiError,
  clearApiKey,
  fetchOperationsReadiness,
  fetchOverview,
  readApiKey,
  triggerSync,
  writeApiKey,
} from "./api";
import { Dashboard } from "./components/Dashboard";
import type { OperationsOverview, OperationsReadiness } from "./types";

type UnlockProps = {
  error?: string | null;
  onUnlock: (apiKey: string) => void;
};

function Unlock({ error, onUnlock }: UnlockProps) {
  const [value, setValue] = useState("");

  return (
    <main className="unlock-shell">
      <section className="unlock-card" aria-labelledby="unlock-title">
        <div className="unlock-mark" aria-hidden="true">I</div>
        <p className="eyebrow">INBOX CONSOLE</p>
        <h1 id="unlock-title">欢迎回来</h1>
        <p className="unlock-access-state">你已通过 Cloudflare Access 身份验证</p>
        <p className="unlock-copy">输入管理 API Key 继续。密钥只保存在当前浏览器会话，关闭标签页后自动清除。</p>
        {error ? <p className="unlock-error" role="alert">{error}</p> : null}
        <form className="unlock-form"
          onSubmit={(event) => {
            event.preventDefault();
            const apiKey = value.trim();
            if (apiKey) onUnlock(apiKey);
          }}
        >
          <TextInput
            {...{ autoComplete: "current-password" }}
            className="unlock-input"
            label="管理 API Key"
            type="password"
            value={value}
            width="100%"
            size="lg"
            onChange={setValue}
          />
          <Button
            className="ops-button unlock-submit"
            label="继续"
            type="submit"
            variant="primary"
            size="lg"
            width="100%"
          />
        </form>
        <p className="unlock-provider-note">Google 或邮箱验证码登录由 Cloudflare Access 提供。</p>
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
          <Button className="ops-button" label="重新加载" variant="primary" onClick={onRetry} />
          <Button className="ops-button" label="更换 API Key" onClick={onLock} />
        </div>
      </section>
    </main>
  );
}

export function App() {
  const [apiKey, setApiKey] = useState(readApiKey);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [readiness, setReadiness] = useState<OperationsReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const lock = useCallback(() => {
    clearApiKey();
    setApiKey("");
    setOverview(null);
    setReadiness(null);
    setError(null);
    setUnlockError(null);
    setNotice(null);
  }, []);

  const rejectApiKey = useCallback(() => {
    lock();
    setUnlockError("API Key 无效，请重新输入");
  }, [lock]);

  const loadOverview = useCallback(async () => {
    if (!apiKey) return;
    setRefreshing(true);
    setError(null);
    try {
      const [nextOverview, nextReadiness] = await Promise.all([
        fetchOverview(apiKey),
        fetchOperationsReadiness(apiKey),
      ]);
      setOverview(nextOverview);
      setReadiness(nextReadiness);
    } catch (reason: unknown) {
      if (reason instanceof ApiError && reason.status === 401) {
        rejectApiKey();
        return;
      }
      setError(reason instanceof Error ? reason.message : "无法加载运行状态");
    } finally {
      setRefreshing(false);
    }
  }, [apiKey, rejectApiKey]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  if (!apiKey) {
    return (
      <Unlock
        error={unlockError}
        onUnlock={(value) => {
          setUnlockError(null);
          writeApiKey(value);
          setApiKey(value);
        }}
      />
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => void loadOverview()} onLock={lock} />;
  if (!overview || !readiness) return <main><p role="status">正在加载运行状态…</p></main>;

  return (
    <Dashboard
      overview={overview}
      readiness={readiness}
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
            if (reason instanceof ApiError && reason.status === 401) rejectApiKey();
            else setError(reason instanceof Error ? reason.message : "同步失败");
          })
          .finally(() => setSyncing(false));
      }}
      onLock={lock}
    />
  );
}
