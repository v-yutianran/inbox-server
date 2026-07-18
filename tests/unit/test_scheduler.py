from inboxserver.infrastructure.scheduler import setup_scheduler


def test_collect_job_runs_every_ten_minutes() -> None:
    scheduler = setup_scheduler()

    job = scheduler.get_job("collect")

    assert job is not None
    assert job.trigger.interval.total_seconds() == 600
