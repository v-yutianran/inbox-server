import { formatTime } from "../format";
import type { ArticleEvent, OperationsOverview } from "../types";

const statusLabels: Record<string, string> = {
  committed: "已归档并推送",
  exists: "已存在",
  skipped: "已跳过",
  failed: "归档失败",
};

function ArticleRow({ event }: { event: ArticleEvent }) {
  return (
    <li>
      <div className="article-state"><span className={`event-badge is-${event.status}`}>{statusLabels[event.status] ?? event.status}</span><time>{formatTime(event.occurred_at)}</time></div>
      <div className="article-copy">
        <a href={event.source_url} target="_blank" rel="noreferrer">{event.title || event.source_url}</a>
        <p>{event.filename ?? event.reason ?? `指纹 ${event.url_fingerprint}`}</p>
      </div>
    </li>
  );
}

export function ArticleHistory({ article_events: events }: Pick<OperationsOverview, "article_events">) {
  return (
    <section className="section-block article-panel" aria-labelledby="article-title">
      <div className="section-heading compact">
        <div><span className="eyebrow">GIT ARCHIVE</span><h2 id="article-title">文章归档</h2></div>
      </div>
      {events.length === 0 ? <p className="empty-copy">尚无归档事件</p> : <ul className="article-list">{events.map((event) => <ArticleRow key={event.id} event={event} />)}</ul>}
    </section>
  );
}
