import { formatTime } from "../format";
import type { HealthComponentState, OperationsReadiness } from "../types";

const componentLabels: Record<string, string> = {
  api: "API",
  browser: "浏览器",
  console: "Console",
  mihomo: "Mihomo",
  warp: "WARP",
  worker: "Worker",
};

const stateLabels: Record<HealthComponentState, string> = {
  degraded: "降级",
  failed: "失败",
  ready: "就绪",
  starting: "启动中",
  stopping: "停止中",
};

const metricLabels: Record<string, string> = {
  "api.availability": "API 可用率",
  "dependency.browser.ready": "浏览器就绪",
  "dependency.mihomo.ready": "Mihomo 就绪",
  "dependency.warp.ready": "WARP 就绪",
  "queue.deferred": "延迟任务",
  "queue.executable": "可执行任务",
  "queue.oldest_executable_age_seconds": "最老可执行任务",
  "worker.heartbeat_age_seconds": "Worker 心跳延迟",
};

function formatDuration(value: number | null): string {
  if (value === null) return "无";
  if (value < 60) return `${value} 秒`;
  if (value < 3_600) return `${Math.floor(value / 60)} 分钟`;
  return `${(value / 3_600).toFixed(1)} 小时`;
}

function formatMetricValue(key: string, value: number): string {
  if (key.endsWith("_seconds")) return formatDuration(value);
  if (key.endsWith(".ready") || key.endsWith(".availability")) return value >= 1 ? "正常" : "异常";
  return String(value);
}

export function OperationsReadinessPanel({ readiness }: { readiness: OperationsReadiness }) {
  const { health, metrics, queue } = readiness;
  const categories = [
    ["可执行", queue.categories.executable],
    ["处理中", queue.categories.processing],
    ["延迟", queue.categories.deferred],
    ["不可执行", queue.categories.nonExecutable],
  ] as const;

  return (
    <section className="section-block readiness-panel" aria-labelledby="readiness-title">
      <div className="section-heading compact">
        <div><span className="eyebrow">OPERATIONS READINESS</span><h2 id="readiness-title">依赖与积压</h2></div>
        <p>组件状态、任务可执行性与近 {metrics.windowHours} 小时低基数指标。</p>
      </div>

      <div className="dependency-grid">
        {health.components.map((component) => (
          <article className={`dependency-card is-${component.state}`} key={component.component}>
            <div><strong>{componentLabels[component.component] ?? component.component}</strong><span>{stateLabels[component.state]}</span></div>
            <p>{component.reasonCode}</p>
            <small>{component.deploymentVersion} · {formatTime(component.observedAt)}</small>
          </article>
        ))}
      </div>

      <div className="readiness-detail-grid">
        <article className="readiness-detail-card">
          <h3>任务状态分类</h3>
          <dl className="category-list">
            {categories.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <p>最老可执行任务：<strong>{formatDuration(queue.oldestExecutableAgeSeconds)}</strong></p>
          <p>最早延迟至：<strong>{queue.earliestDeferredAt ? formatTime(queue.earliestDeferredAt) : "无"}</strong></p>
        </article>

        <article className="readiness-detail-card metric-card">
          <h3>运行指标</h3>
          <ul className="metric-list">
            {metrics.metrics.map((metric) => (
              <li key={metric.key}>
                <span><strong>{metricLabels[metric.key] ?? metric.key}</strong><small>{metric.trend.length} 个样本</small></span>
                <span>{formatMetricValue(metric.key, metric.current)}</span>
                {metric.threshold ? <small>候选阈值 {metric.threshold.comparison === "gt" ? ">" : "<"} {metric.threshold.value}</small> : null}
              </li>
            ))}
          </ul>
          <p className="metrics-version">版本 {metrics.deploymentVersion} · {formatTime(metrics.generatedAt)}</p>
        </article>
      </div>
    </section>
  );
}
