import type { SyncJob } from "./types";

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatTime(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : "暂无";
}

export function totalEnqueued(job: SyncJob): number {
  let total = 0;
  for (const result of Object.values(job.stats)) {
    for (const count of Object.values(result.enqueued ?? {})) total += count;
  }
  return total;
}
