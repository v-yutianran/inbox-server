import { formatTime } from "../format";
import type { OperationsOverview } from "../types";

type Props = Pick<OperationsOverview, "server" | "worker" | "scheduler">;

function StatusDot({ online }: { online: boolean }) {
  return <span className={online ? "status-dot is-online" : "status-dot"} aria-hidden="true" />;
}

export function StatusOverview({ server, worker, scheduler }: Props) {
  const intervalMinutes = Math.round(scheduler.interval_seconds / 60);
  return (
    <section className="status-grid" aria-label="服务状态">
      <article className="status-card status-card--primary">
        <div className="status-card__topline"><span>API</span><span>01</span></div>
        <div className="status-card__body">
          <StatusDot online={server.online} />
          <h2>{server.online ? "服务在线" : "服务离线"}</h2>
          <p>FastAPI / PostgreSQL / Redis</p>
        </div>
      </article>
      <article className="status-card">
        <div className="status-card__topline"><span>CONSUMER</span><span>02</span></div>
        <div className="status-card__body">
          <StatusDot online={worker.online} />
          <h2>{worker.online ? "Worker 在线" : "Worker 离线"}</h2>
          <p>心跳 {formatTime(worker.last_heartbeat_at)}</p>
        </div>
      </article>
      <article className="status-card">
        <div className="status-card__topline"><span>SCHEDULE</span><span>03</span></div>
        <div className="status-card__body">
          <StatusDot online={scheduler.enabled} />
          <h2>{scheduler.enabled ? `每 ${intervalMinutes} 分钟` : "调度已关闭"}</h2>
          <p>下次 {formatTime(scheduler.next_run_at)}</p>
        </div>
      </article>
    </section>
  );
}
