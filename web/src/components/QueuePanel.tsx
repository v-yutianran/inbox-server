import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";

import type { OperationsOverview } from "../types";

const queueOrder = ["link", "text", "file", "article"] as const;

export function QueuePanel({ queues }: Pick<OperationsOverview, "queues">) {
  return (
    <section className="section-block" aria-labelledby="queues-title">
      <div className="section-heading">
        <div><span className="eyebrow">FLOW CONTROL</span><h2 id="queues-title">队列脉搏</h2></div>
        <p>实时读取 Redis 队列与七日去重窗口</p>
      </div>
      <div className="queue-grid">
        {queueOrder.map((name) => {
          const stats = queues[name];
          return (
            <Card className="queue-card" key={name} padding={0} role="article">
              <div className="queue-card__header">
                <h3>{name[0].toUpperCase() + name.slice(1)} 队列</h3>
                <Badge variant={stats.dlq > 0 ? "error" : "neutral"} label={stats.dlq > 0 ? `${stats.dlq} 异常` : "正常"} />
              </div>
              <strong>{stats.pending.toString().padStart(2, "0")}</strong>
              <div className="queue-card__meta">
                <span>待处理</span><span>已完成 {stats.done}</span><span>DLQ {stats.dlq}</span>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
