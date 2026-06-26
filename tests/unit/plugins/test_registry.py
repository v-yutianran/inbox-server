"""注册表测试：内置三个目的地插件可加载（兜底路径）。"""

from inboxserver.plugins.registry import load_destinations


def test_load_destinations_has_builtin():
    reg = load_destinations()
    names = reg.names()
    assert "cubox" in names
    assert "flomo" in names
    assert "jianguoyun" in names


def test_registry_get_returns_class():
    reg = load_destinations()
    cls = reg.get("cubox")
    assert cls is not None
    assert cls.name == "cubox"
    assert cls.item_kind.value == "link"
