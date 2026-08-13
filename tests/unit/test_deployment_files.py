"""部署文件契约：固定镜像、共享配置与 Compose 数据连续性。"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def test_git_manager_config_enables_quality_gate_and_automatic_cd() -> None:
    config = yaml.safe_load((ROOT / "git-manager.yml").read_text())
    generated_ci = (ROOT / ".github/workflows/git-manager-ci.yml").read_text()
    legacy_ci = (ROOT / ".github/workflows/ci.yml").read_text()

    assert config["version"] == "0.1.0"
    assert config["ci"]["branches"] == ["main"]
    quality_job = config["ci"]["jobs"][0]
    install_command = quality_job["installCommand"]
    assert quality_job["stack"] == "python"
    assert "npm ci" in install_command
    assert "pnpm" not in install_command
    assert quality_job["checkCommands"] == [
        'uv run ruff check src/inboxserver tests scripts',
        'uv run pytest tests/unit tests/integration -m "not e2e" --tb=short',
        "uv run mypy src/inboxserver --ignore-missing-imports",
    ]
    assert config["cd"] == {
        "environment": "testing",
        "runner": "ubuntu-latest",
        "timeoutMinutes": 30,
        "retainReleases": 5,
        "autoDeploy": True,
    }
    assert "actions/setup-python@" in generated_ci
    assert "npm ci" in generated_ci
    assert "pnpm" not in generated_ci
    assert "actions/setup-node@" in legacy_ci
    assert "cache: npm" in legacy_ci
    assert "npm ci" in legacy_ci
    assert "pnpm" not in legacy_ci


def test_container_images_and_restart_policies_are_reproducible() -> None:
    compose = yaml.safe_load((ROOT / "docker-compose.yml").read_text())
    services = compose["services"]

    assert services["postgres"]["image"] == "postgres:16.14-bookworm"
    assert services["redis"]["image"] == "redis:7.4.9-bookworm"
    for name in ("postgres", "redis", "server", "worker", "console"):
        assert services[name]["restart"] == "unless-stopped"
        assert "healthcheck" in services[name]
    assert "ports" not in services["server"]
    assert services["console"]["ports"] == ["127.0.0.1:8000:80"]
    assert services["console"]["build"]["target"] == "console"
    assert "-Y off" in " ".join(services["console"]["healthcheck"]["test"])
    assert services["console"]["depends_on"]["server"]["condition"] == "service_healthy"
    assert services["server"]["depends_on"]["redis"]["condition"] == "service_healthy"
    assert services["worker"]["depends_on"]["redis"]["condition"] == "service_healthy"
    assert services["worker"]["depends_on"]["server"]["condition"] == "service_healthy"
    assert "${HOME}/.agents:/article-repository" in services["worker"]["volumes"]
    assert all("/.ssh:" not in volume for volume in services["worker"]["volumes"])

    dockerfile = (ROOT / "Dockerfile").read_text()
    assert "ghcr.io/astral-sh/uv:0.11.29" in dockerfile
    assert "ghcr.io/astral-sh/uv:latest" not in dockerfile
    assert "nginx:1.30.3-alpine3.23" in dockerfile

    nginx_config = (ROOT / "deploy/nginx.conf").read_text()
    assert "location = /" in nginx_config
    assert "location /assets/" in nginx_config
    assert "proxy_pass http://server:8000" in nginx_config


def test_worker_healthcheck_uses_redis_heartbeat_instead_of_pid() -> None:
    compose = yaml.safe_load((ROOT / "docker-compose.yml").read_text())
    command = " ".join(compose["services"]["worker"]["healthcheck"]["test"])

    assert "python -m inboxserver.workers.healthcheck" in command
    assert "pgrep" not in command


def test_typescript_worker_entrypoint_removes_stale_x11_socket() -> None:
    entrypoint = (ROOT / "apps/worker/docker-entrypoint.sh").read_text()

    assert 'rm -f "/tmp/.X${lock_number}-lock" "/tmp/.X11-unix/X${lock_number}"' in entrypoint
    assert 'while [ "$xvfb_attempt" -lt 5 ]' in entrypoint
    assert 'kill "$xvfb_pid"' in entrypoint


def test_typescript_worker_entrypoint_waits_for_slow_xvfb_socket(tmp_path: Path) -> None:
    """资源受限节点上 Xvfb 超过五秒才就绪时仍应启动 Worker。"""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    invocation_marker = tmp_path / "xvfb-invoked"
    worker_marker = tmp_path / "worker-started"
    display_number = "199"
    socket_path = Path(f"/tmp/.X11-unix/X{display_number}")
    lock_path = Path(f"/tmp/.X{display_number}-lock")
    socket_path.parent.mkdir(mode=0o1777, parents=True, exist_ok=True)

    fake_xvfb = fake_bin / "Xvfb"
    fake_xvfb.write_text(
        """#!/bin/sh
if [ -e "$FAKE_XVFB_INVOKED" ]; then
  exit 1
fi
touch "$FAKE_XVFB_INVOKED"
exec python3 -c 'import os, socket, time
time.sleep(6)
server = socket.socket(socket.AF_UNIX)
server.bind(os.environ["FAKE_XVFB_SOCKET"])
time.sleep(1)'
"""
    )
    fake_xvfb.chmod(0o755)

    fake_node = fake_bin / "node"
    fake_node.write_text("#!/bin/sh\ntouch \"$FAKE_WORKER_STARTED\"\n")
    fake_node.chmod(0o755)

    environment = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "DISPLAY": f":{display_number}",
        "FAKE_XVFB_INVOKED": str(invocation_marker),
        "FAKE_XVFB_SOCKET": str(socket_path),
        "FAKE_WORKER_STARTED": str(worker_marker),
    }
    try:
        result = subprocess.run(
            ["sh", str(ROOT / "apps/worker/docker-entrypoint.sh")],
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=40,
        )
    finally:
        socket_path.unlink(missing_ok=True)
        lock_path.unlink(missing_ok=True)

    assert result.returncode == 0, result.stderr
    assert worker_marker.exists()


def test_typescript_worker_entrypoint_reports_xvfb_failure(tmp_path: Path) -> None:
    """Xvfb 永久失败时应以稳定低基数事件退出。"""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_xvfb = fake_bin / "Xvfb"
    fake_xvfb.write_text("#!/bin/sh\nexit 1\n")
    fake_xvfb.chmod(0o755)

    environment = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "DISPLAY": ":198",
    }
    result = subprocess.run(
        ["sh", str(ROOT / "apps/worker/docker-entrypoint.sh")],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )

    assert result.returncode != 0
    assert result.stderr.strip().splitlines()[-1] == '{"event":"xvfb_failed"}'


def test_sealos_worker_allows_slow_lazy_image_startup() -> None:
    documents = list(yaml.safe_load_all((ROOT / "deploy/sealos/worker-staging.yaml").read_text()))
    stateful_set = next(document for document in documents if document["kind"] == "StatefulSet")
    worker = next(
        container
        for container in stateful_set["spec"]["template"]["spec"]["containers"]
        if container["name"] == "inbox-server-worker-staging"
    )

    assert worker["startupProbe"]["failureThreshold"] == 240
    worker_environment = {item["name"]: item.get("value") for item in worker["env"]}
    assert worker_environment["BROWSER_LAUNCH_TIMEOUT_MS"] == "900000"
    assert "failureThreshold: 240" in (ROOT / "template/inbox-server-worker/index.yaml").read_text()
    assert "BROWSER_LAUNCH_TIMEOUT_MS" in (
        ROOT / "template/inbox-server-worker/index.yaml"
    ).read_text()


def test_sealos_worker_tolerates_transient_io_pressure_after_startup() -> None:
    documents = list(yaml.safe_load_all((ROOT / "deploy/sealos/worker-staging.yaml").read_text()))
    stateful_set = next(document for document in documents if document["kind"] == "StatefulSet")
    worker = next(
        container
        for container in stateful_set["spec"]["template"]["spec"]["containers"]
        if container["name"] == "inbox-server-worker-staging"
    )

    assert worker["livenessProbe"]["failureThreshold"] == 10
    assert worker["livenessProbe"]["timeoutSeconds"] == 10

    template = (ROOT / "template/inbox-server-worker/index.yaml").read_text()
    assert "failureThreshold: 10" in template
    assert "timeoutSeconds: 10" in template


def test_sealos_warp_has_cpu_budget_for_daemon_watchdog() -> None:
    documents = list(yaml.safe_load_all((ROOT / "deploy/sealos/worker-staging.yaml").read_text()))
    stateful_set = next(document for document in documents if document["kind"] == "StatefulSet")
    warp = next(
        container
        for container in stateful_set["spec"]["template"]["spec"]["containers"]
        if container["name"] == "warp-egress"
    )

    assert warp["resources"]["requests"]["cpu"] == "250m"
    assert warp["resources"]["limits"]["cpu"] == "1"


def test_typescript_worker_routes_control_plane_through_outbound_proxy() -> None:
    """心跳、状态和队列请求必须复用已就绪的 WARP HTTP 出口。"""
    main = (ROOT / "apps/worker/src/main.ts").read_text()

    assert "serviceToken,\n        externalFetch," in main
    assert "const queue = createControlPlaneQueueClient(\n        {" in main
    assert "        externalFetch,\n      );" in main


def test_entrypoint_links_shared_config_and_uses_fixed_compose_project(tmp_path: Path) -> None:
    deploy_root = tmp_path / "inbox-server"
    release = deploy_root / "releases" / "release-test"
    shared = deploy_root / "shared"
    fake_bin = tmp_path / "bin"
    release.mkdir(parents=True)
    shared.mkdir()
    fake_bin.mkdir()

    shutil.copy2(ROOT / "entrypoint.sh", release / "entrypoint.sh")
    shutil.copy2(ROOT / "docker-compose.yml", release / "docker-compose.yml")
    (shared / ".env").write_text("INBOX_ADMIN_API_KEY=test\n")
    (shared / "channels.yaml").write_text("sources: {}\ndestinations: {}\n")

    docker_log = tmp_path / "docker.log"
    fake_docker = fake_bin / "docker"
    fake_docker.write_text(
        """#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  "compose version") exit 0 ;;
  *" ps --services --status running")
    printf 'postgres\nredis\nserver\nworker\nconsole\n'
    ;;
  *" ps -q "*)
    for service do :; done
    printf 'cid-%s\n' "$service"
    ;;
  inspect*)
    printf 'unless-stopped\n'
    ;;
  "volume inspect "*) exit 0 ;;
esac
"""
    )
    fake_docker.chmod(0o755)
    fake_curl = fake_bin / "curl"
    fake_curl.write_text("#!/bin/sh\nexit 0\n")
    fake_curl.chmod(0o755)

    environment = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_DOCKER_LOG": str(docker_log),
        "INBOX_DEPLOY_ROOT": str(deploy_root),
        "INBOX_SHARED_DIR": str(shared),
        "INBOX_DEPLOY_TIMEOUT_SECONDS": "1",
    }
    result = subprocess.run(
        ["sh", str(release / "entrypoint.sh")],
        cwd=release,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    assert (release / ".env").resolve() == shared / ".env"
    assert (release / "channels.yaml").resolve() == shared / "channels.yaml"
    log = docker_log.read_text()
    assert "compose -p inbox-server" in log
    assert "config --quiet" in log
    assert "up -d --build --remove-orphans --wait --wait-timeout 1" in log
    assert "volume inspect inbox-server_pgdata inbox-server_redisdata" in log
