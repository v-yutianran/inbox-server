import { Card } from "@astryxdesign/core/Card";
import { StatusDot } from "@astryxdesign/core/StatusDot";

import { formatTime } from "../format";
import type { OperationsOverview } from "../types";

type Props = Pick<OperationsOverview, "server" | "worker" | "scheduler">;

export function StatusOverview({ server, worker, scheduler }: Props) {
  const intervalMinutes = Math.round(scheduler.interval_seconds / 60);
  return (
    <section className="status-grid" aria-label="服务状态">
      <Card className="status-card status-card--primary" padding={0} role="article">
        <div className="status-card__topline"><span>API</span><span>01</span></div>
        <div className="status-card__body">
          <StatusDot variant={server.online ? "success" : "error"} label={server.online ? "API 在线" : "API 离线"} />
          <h2>{server.online ? "服务在线" : "服务离线"}</h2>
          <p>Cloudflare Workers / D1 / Queues</p>
        </div>
      </Card>
      <Card className="status-card" padding={0} role="article">
        <div className="status-card__topline"><span>CONSUMER</span><span>02</span></div>
        <div className="status-card__body">
          <StatusDot variant={worker.online ? "success" : "error"} label={worker.online ? "Worker 在线" : "Worker 离线"} />
          <h2>{worker.online ? "Worker 在线" : "Worker 离线"}</h2>
          <p>心跳 {formatTime(worker.last_heartbeat_at)}</p>
        </div>
      </Card>
      <Card className="status-card" padding={0} role="article">
        <div className="status-card__topline"><span>SCHEDULE</span><span>03</span></div>
        <div className="status-card__body">
          <StatusDot variant={scheduler.enabled ? "success" : "warning"} label={scheduler.enabled ? "调度已启用" : "调度已关闭"} />
          <h2>{scheduler.enabled ? `每 ${intervalMinutes} 分钟` : "调度已关闭"}</h2>
          <p>下次 {formatTime(scheduler.next_run_at)}</p>
        </div>
      </Card>
    </section>
  );
}
