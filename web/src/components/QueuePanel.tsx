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
            <article className="queue-card" key={name}>
              <div className="queue-card__header">
                <h3>{name[0].toUpperCase() + name.slice(1)} 队列</h3>
                <span className={stats.dlq > 0 ? "queue-alert" : "queue-ok"}>
                  {stats.dlq > 0 ? `${stats.dlq} 异常` : "正常"}
                </span>
              </div>
              <strong>{stats.pending.toString().padStart(2, "0")}</strong>
              <div className="queue-card__meta">
                <span>待处理</span><span>已完成 {stats.done}</span><span>DLQ {stats.dlq}</span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
