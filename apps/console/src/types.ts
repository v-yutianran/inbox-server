export type QueueStats = {
  pending: number;
  dlq: number;
  done: number;
};

export type ChannelSummary = {
  enabled: boolean;
  kind?: string | null;
  item_kind?: string | null;
  credential_name?: string | null;
};

export type SyncJob = {
  id: string;
  triggered_by: "manual" | "scheduler" | string;
  status: "running" | "done" | "failed" | string;
  stats: Record<string, { enqueued?: Record<string, number> }>;
  started_at: string;
  finished_at: string | null;
  error: string | null;
};

export type ArticleEvent = {
  id: number;
  source_url: string;
  url_fingerprint: string;
  title: string;
  status: "committed" | "exists" | "skipped" | "failed" | string;
  reason: string | null;
  filename: string | null;
  occurred_at: string;
};

export type OperationsOverview = {
  status: "ok";
  generated_at: string;
  server: { online: boolean };
  worker: { online: boolean; last_heartbeat_at: string | null };
  scheduler: {
    enabled: boolean;
    interval_seconds: number;
    next_run_at: string | null;
  };
  channels: {
    sources: Record<string, ChannelSummary>;
    destinations: Record<string, ChannelSummary>;
  };
  queues: Record<"link" | "text" | "file" | "article", QueueStats>;
  sync_jobs: SyncJob[];
  article_events: ArticleEvent[];
};

export type SyncResponse = {
  status: "ok";
  results: Record<string, unknown>;
};
