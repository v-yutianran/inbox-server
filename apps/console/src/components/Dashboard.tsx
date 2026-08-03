import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";

import { formatTime } from "../format";
import type { OperationsOverview, OperationsReadiness } from "../types";
import { ArticleHistory } from "./ArticleHistory";
import { ChannelsPanel } from "./ChannelsPanel";
import { QueuePanel } from "./QueuePanel";
import { OperationsReadinessPanel } from "./OperationsReadinessPanel";
import { StatusOverview } from "./StatusOverview";
import { SyncHistory } from "./SyncHistory";

type Props = {
  overview: OperationsOverview;
  readiness: OperationsReadiness;
  refreshing: boolean;
  syncing: boolean;
  notice: string | null;
  onRefresh: () => void;
  onSync: () => void;
  onLock: () => void;
};

export function Dashboard({
  overview,
  readiness,
  refreshing,
  syncing,
  notice,
  onRefresh,
  onSync,
  onLock,
}: Props) {
  return (
    <main className="console-shell">
      <header className="console-header">
        <div className="brand-mark"><span>INBOX</span><strong>OPS</strong></div>
        <div className="header-copy"><span className="eyebrow">PRIVATE DISTRIBUTION SYSTEM</span><h1>运行总览</h1></div>
        <div className="header-stamp"><span>数据时间</span><strong>{formatTime(overview.generated_at)}</strong></div>
        <div className="header-actions">
          <Button className="ops-button" label="立即同步" variant="primary" onClick={onSync} isLoading={syncing} />
          <Button className="ops-button" label="刷新状态" onClick={onRefresh} isLoading={refreshing} />
          <Button className="ops-button lock-button" label="锁定" variant="ghost" size="sm" onClick={onLock} />
        </div>
      </header>
      {notice ? <Banner className="notice" status="success" title={notice} /> : null}
      <StatusOverview server={overview.server} worker={overview.worker} scheduler={overview.scheduler} />
      <OperationsReadinessPanel readiness={readiness} />
      <QueuePanel queues={overview.queues} />
      <div className="split-grid">
        <ChannelsPanel channels={overview.channels} />
        <SyncHistory sync_jobs={overview.sync_jobs} />
      </div>
      <ArticleHistory article_events={overview.article_events} />
      <footer><span>INBOX-SERVER / ASIA-SHANGHAI</span><span>PRIVATE OPERATIONS CONSOLE</span></footer>
    </main>
  );
}
