"""重试/配额/DLQ 决策测试（命门：配额超绝不误进 DLQ）。"""

from inboxserver.domain.policy.retry import (
    MAX_RETRY,
    RetryAction,
    decide_on_failure,
    decide_on_quota,
    decide_on_success,
)


def test_success_is_done():
    assert decide_on_success().action is RetryAction.DONE


def test_quota_stops_without_counting_retry():
    """配额超：STOP_QUOTA，不计 retry（区别于失败重试）。"""
    d = decide_on_quota()
    assert d.action is RetryAction.STOP_QUOTA
    assert d.retry == 0


def test_failure_first_two_requeue():
    """第 1、2 次失败 → REQUEUE 回队尾重试。"""
    assert decide_on_failure(0).action is RetryAction.REQUEUE
    assert decide_on_failure(1).action is RetryAction.REQUEUE


def test_failure_third_goes_to_dlq():
    """第 3 次失败（current_retry=2）→ MOVE_TO_DLQ。"""
    d = decide_on_failure(2)
    assert d.action is RetryAction.MOVE_TO_DLQ
    assert d.retry == MAX_RETRY


def test_failure_requeue_increments_retry():
    """REQUEUE 时 retry 递增（回写 item）。"""
    assert decide_on_failure(0).retry == 1
    assert decide_on_failure(1).retry == 2
