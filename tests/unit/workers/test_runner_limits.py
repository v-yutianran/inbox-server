"""worker runner 的队列限速配置契约。"""

from inboxserver.domain.models import ItemKind
from inboxserver.workers.runner import LIMITS


def test_link_uses_daily_500_without_fixed_window() -> None:
    limits = LIMITS[ItemKind.LINK]

    assert limits.window_count == 0
    assert limits.daily_limit == 500
    assert limits.interval == 5


def test_non_link_limits_remain_unchanged() -> None:
    text = LIMITS[ItemKind.TEXT]
    file = LIMITS[ItemKind.FILE]

    assert (text.window_count, text.window_sec, text.daily_limit, text.interval) == (
        25,
        21600,
        96,
        10,
    )
    assert (file.window_count, file.window_sec, file.daily_limit, file.interval) == (
        1400,
        1800,
        None,
        1,
    )
