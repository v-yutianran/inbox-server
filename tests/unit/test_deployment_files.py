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
    assert config["ci"]["jobs"][0]["stack"] == "node"
    assert "pnpm install --frozen-lockfile" in config["ci"]["jobs"][0][
        "installCommand"
    ]
    assert config["ci"]["jobs"][0]["checkCommands"] == [
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
    for workflow in (generated_ci, legacy_ci):
        assert "pnpm/action-setup@" in workflow
        assert "actions/setup-node@" in workflow
        assert "pnpm install --frozen-lockfile" in workflow


def test_container_images_and_restart_policies_are_reproducible() -> None:
    compose = yaml.safe_load((ROOT / "docker-compose.yml").read_text())
    services = compose["services"]

    assert services["postgres"]["image"] == "postgres:16.14-bookworm"
    assert services["redis"]["image"] == "redis:7.4.9-bookworm"
    for name in ("postgres", "redis", "server", "worker"):
        assert services[name]["restart"] == "unless-stopped"
        assert "healthcheck" in services[name]
    assert services["server"]["ports"] == ["127.0.0.1:8000:8000"]
    assert services["server"]["depends_on"]["redis"]["condition"] == "service_healthy"
    assert services["worker"]["depends_on"]["redis"]["condition"] == "service_healthy"
    assert services["worker"]["depends_on"]["server"]["condition"] == "service_healthy"
    assert "${HOME}/.agents:/article-repository" in services["worker"]["volumes"]
    assert all("/.ssh:" not in volume for volume in services["worker"]["volumes"])

    dockerfile = (ROOT / "Dockerfile").read_text()
    assert "ghcr.io/astral-sh/uv:0.11.29" in dockerfile
    assert "ghcr.io/astral-sh/uv:latest" not in dockerfile


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
    printf 'postgres\nredis\nserver\nworker\n'
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
