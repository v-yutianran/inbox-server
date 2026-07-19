import { formatTime, totalEnqueued } from "../format";
import type { OperationsOverview } from "../types";

export function SyncHistory({ sync_jobs: jobs }: Pick<OperationsOverview, "sync_jobs">) {
  return (
    <section className="section-block history-panel" aria-labelledby="sync-title">
      <div className="section-heading compact">
        <div><span className="eyebrow">SYNC RUNS</span><h2 id="sync-title">最近同步</h2></div>
      </div>
      {jobs.length === 0 ? <p className="empty-copy">尚无同步运行记录</p> : (
        <ol className="timeline">
          {jobs.map((job) => (
            <li key={job.id}>
              <span className={`timeline__mark is-${job.status}`} />
              <div className="timeline__content">
                <div><strong>{job.triggered_by === "manual" ? "手动触发" : "自动调度"}</strong><time>{formatTime(job.started_at)}</time></div>
                <p>{job.status === "done" ? `完成 · 新增 ${totalEnqueued(job)} 项` : job.status === "running" ? "执行中" : `失败 · ${job.error ?? "未知错误"}`}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
