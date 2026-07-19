import type { ChannelSummary, OperationsOverview } from "../types";

function ChannelList({ title, items }: { title: string; items: Record<string, ChannelSummary> }) {
  const entries = Object.entries(items);
  return (
    <div className="channel-column">
      <h3>{title}<span>{entries.length}</span></h3>
      {entries.length === 0 ? <p className="empty-copy">暂无渠道</p> : (
        <ul className="channel-list">
          {entries.map(([name, channel]) => (
            <li key={name}>
              <span className={channel.enabled ? "status-dot is-online" : "status-dot"} />
              <div><strong>{name}</strong><small>{channel.kind ?? channel.item_kind ?? "未分类"}</small></div>
              <span className="channel-state">{channel.enabled ? "启用" : "停用"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ChannelsPanel({ channels }: Pick<OperationsOverview, "channels">) {
  return (
    <section className="section-block channels-panel" aria-labelledby="channels-title">
      <div className="section-heading compact">
        <div><span className="eyebrow">ROUTING MAP</span><h2 id="channels-title">渠道矩阵</h2></div>
      </div>
      <div className="channel-grid">
        <ChannelList title="采集来源" items={channels.sources} />
        <ChannelList title="分发目标" items={channels.destinations} />
      </div>
    </section>
  );
}
