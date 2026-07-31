const port = process.env.HEALTH_PORT ?? "8080";

export {};

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
