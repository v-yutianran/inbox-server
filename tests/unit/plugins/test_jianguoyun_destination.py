"""坚果云目的地测试（mock webdav client，不触真实 WebDAV）。"""

from inboxserver.plugins.contracts import DispatchOutcome
from inboxserver.plugins.destinations.jianguoyun import JianguoyunDestination


class _FakeWebdavClient:
    """记录上传调用的假 client。"""

    def __init__(self):
        self.uploaded = []

    def upload_file(self, remote, local):
        self.uploaded.append((remote, local))


class _FailingWebdavClient:
    def upload_file(self, remote, local):
        raise RuntimeError("upload failed")


async def test_jianguoyun_success():
    client = _FakeWebdavClient()
    dest = JianguoyunDestination(
        {"webdav_user": "u", "webdav_pass": "p"}, webdav_client=client
    )
    ok, outcome = await dest.dispatch({"local_path": "/tmp/a.html", "remote_name": "a.html"})
    assert ok is True and outcome is DispatchOutcome.OK
    assert client.uploaded == [("/我的坚果云/a.html", "/tmp/a.html")]


async def test_jianguoyun_fail():
    dest = JianguoyunDestination(
        {"webdav_user": "u", "webdav_pass": "p"}, webdav_client=_FailingWebdavClient()
    )
    ok, outcome = await dest.dispatch({"local_path": "/x", "remote_name": "x"})
    assert ok is False and outcome is DispatchOutcome.FAIL
