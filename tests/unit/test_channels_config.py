"""channels config 启动校验测试（P1-6 fail-fast）。

校验 load_channels 对启用渠道 config 的强类型校验：
- 缺字段 → ValueError（启动即暴露，而非运行到 source 构造才 KeyError）
- 字段齐全 → 正常加载
- 禁用渠道 → 跳过校验
- 未注册模型的渠道（自定义插件）→ 跳过校验（保持扩展性）
"""

from __future__ import annotations

import pytest
import yaml

from inboxserver.config.channels import load_channels


def _write_channels(tmp_path, *, sources=None, destinations=None) -> object:
    """写临时 channels.yaml，返回路径。"""
    data: dict = {}
    if sources is not None:
        data["sources"] = sources
    if destinations is not None:
        data["destinations"] = destinations
    p = tmp_path / "channels.yaml"
    p.write_text(yaml.safe_dump(data))
    return p


def test_validate_source_missing_field_raises(tmp_path):
    """启用 telegram 但缺 bot_token → load_channels 抛 ValueError（fail-fast）。"""
    p = _write_channels(tmp_path, sources={"telegram": {"enabled": True, "config": {}}})
    with pytest.raises(ValueError, match="telegram"):
        load_channels(p)


def test_validate_source_complete_ok(tmp_path):
    """启用 telegram + 字段齐全 → 正常加载。"""
    p = _write_channels(
        tmp_path,
        sources={"telegram": {"enabled": True, "config": {"bot_token": "T"}}},
    )
    cfg = load_channels(p)
    assert "telegram" in cfg.enabled_sources()


def test_validate_zhihu_requires_both_fields(tmp_path):
    """知乎需 credential_name + collection_id 两个都给（browser 源多字段校验）。"""
    p = _write_channels(
        tmp_path,
        sources={"zhihu": {"enabled": True, "config": {"credential_name": "zhihu_creds"}}},
    )
    with pytest.raises(ValueError, match="zhihu"):
        load_channels(p)


def test_validate_github_stars_requires_token(tmp_path):
    """GitHub Star source 启用时必须配置 token。"""
    p = _write_channels(tmp_path, sources={"github_stars": {"enabled": True, "config": {}}})
    with pytest.raises(ValueError, match="github_stars"):
        load_channels(p)


def test_validate_github_stars_complete_ok(tmp_path):
    """GitHub Star source 配置 token 后可正常加载。"""
    p = _write_channels(
        tmp_path,
        sources={"github_stars": {"enabled": True, "config": {"token": "ghp_test"}}},
    )
    cfg = load_channels(p)
    assert "github_stars" in cfg.enabled_sources()


def test_validate_x_bookmarks_requires_credential_name(tmp_path):
    """X Bookmarks source 启用时必须配置 credential_name。"""
    p = _write_channels(tmp_path, sources={"x_bookmarks": {"enabled": True, "config": {}}})
    with pytest.raises(ValueError, match="x_bookmarks"):
        load_channels(p)


def test_validate_x_likes_accepts_optional_username(tmp_path):
    """X Likes source 可只配置 credential_name；username 未填时运行期自动识别。"""
    p = _write_channels(
        tmp_path,
        sources={"x_likes": {"enabled": True, "config": {"credential_name": "x_creds"}}},
    )
    cfg = load_channels(p)
    assert "x_likes" in cfg.enabled_sources()


def test_validate_destination_missing_field_raises(tmp_path):
    """启用 cubox 但缺 api_url → fail-fast。"""
    p = _write_channels(
        tmp_path,
        destinations={"cubox": {"enabled": True, "config": {}, "item_kind": "link"}},
    )
    with pytest.raises(ValueError, match="cubox"):
        load_channels(p)


def test_validate_disabled_channel_skipped(tmp_path):
    """禁用渠道不校验（缺字段也不报错，因为不会运行）。"""
    p = _write_channels(
        tmp_path,
        sources={"telegram": {"enabled": False, "config": {}}},
    )
    cfg = load_channels(p)  # 不抛
    assert "telegram" not in cfg.enabled_sources()


def test_validate_unknown_channel_skipped(tmp_path):
    """未注册模型的渠道（自定义插件）跳过校验，保持扩展性。"""
    p = _write_channels(
        tmp_path,
        sources={"custom_source": {"enabled": True, "config": {"any": "thing"}}},
    )
    cfg = load_channels(p)  # 不抛
    assert "custom_source" in cfg.enabled_sources()
