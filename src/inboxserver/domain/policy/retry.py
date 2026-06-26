"""重试/配额/死信决策（纯函数；消费循环在 workers/consumer）。

规则（来自 worker.consume，严格区分三种结局——配额超绝不误进 DLQ）：
  成功         → DONE（mark_done + daily_incr，不再处理）
  配额超(-3030) → STOP_QUOTA（回队首不计 retry，停队列等明天恢复，**不进 DLQ**）
  失败/异常     → retry+1；retry>=MAX_RETRY 进 DLQ，否则 REQUEUE 回队尾重试
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

# 失败重试上限：达到即移入死信队列（DLQ 仅收永久失败，配额超不算）
MAX_RETRY = 3


class RetryAction(StrEnum):
    DONE = "done"  # 成功
    REQUEUE = "requeue"  # 回队尾重试（计 retry）
    STOP_QUOTA = "stop_quota"  # 配额超：回队首不计 retry，停队列等明天
    MOVE_TO_DLQ = "move_to_dlq"  # 失败满 MAX_RETRY，进死信


@dataclass(frozen=True)
class RetryDecision:
    """重试决策结果。retry 为决策后回写 item 的计数。"""

    action: RetryAction
    retry: int


def decide_on_success() -> RetryDecision:
    """成功：标记完成，不再处理。"""
    return RetryDecision(action=RetryAction.DONE, retry=0)


def decide_on_quota() -> RetryDecision:
    """配额超（如 Cubox -3030）：回队首不计 retry，停队列等明天（不进 DLQ）。"""
    return RetryDecision(action=RetryAction.STOP_QUOTA, retry=0)


def decide_on_failure(current_retry: int) -> RetryDecision:
    """失败/异常：retry+1，满 MAX_RETRY 进 DLQ，否则回队尾重试。"""
    new_retry = current_retry + 1
    if new_retry >= MAX_RETRY:
        return RetryDecision(action=RetryAction.MOVE_TO_DLQ, retry=new_retry)
    return RetryDecision(action=RetryAction.REQUEUE, retry=new_retry)
