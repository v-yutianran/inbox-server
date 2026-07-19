import { formatTime } from "../format";
import type { OperationsOverview } from "../types";
import { ArticleHistory } from "./ArticleHistory";
import { ChannelsPanel } from "./ChannelsPanel";
import { QueuePanel } from "./QueuePanel";
import { StatusOverview } from "./StatusOverview";
import { SyncHistory } from "./SyncHistory";

type Props = {
  overview: OperationsOverview;
  refreshing: boolean;
  syncing: boolean;
  notice: string | null;
  onRefresh: () => void;
  onSync: () => void;
  onLock: () => void;
};

export function Dashboard({
  overview,
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
          <button className="button button--signal" type="button" onClick={onSync} disabled={syncing}>
            {syncing ? "同步中…" : "立即同步"}
          </button>
          <button className="button" type="button" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "刷新中…" : "刷新状态"}
          </button>
          <button className="text-button" type="button" onClick={onLock}>锁定</button>
        </div>
      </header>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <StatusOverview server={overview.server} worker={overview.worker} scheduler={overview.scheduler} />
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
