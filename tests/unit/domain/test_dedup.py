"""去重指纹纯函数测试（fingerprint/done_key/DONE_TTL）。"""

from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.dedup import DONE_TTL, done_key, fingerprint


def test_fingerprint_link_is_url():
    assert fingerprint({"url": "https://x.com"}, ItemKind.LINK) == "https://x.com"


def test_fingerprint_text_is_md5():
    # md5("hello") = 5d41402abc4b2a76b9719d911017c592
    assert fingerprint({"content": "hello"}, ItemKind.TEXT) == "5d41402abc4b2a76b9719d911017c592"


def test_fingerprint_file_is_remote_name():
    assert fingerprint({"remote_name": "a.html"}, ItemKind.FILE) == "a.html"


def test_fingerprint_same_content_same_fp():
    a = fingerprint({"content": "same"}, ItemKind.TEXT)
    b = fingerprint({"content": "same"}, ItemKind.TEXT)
    assert a == b


def test_fingerprint_different_content_different_fp():
    fp_a = fingerprint({"content": "a"}, ItemKind.TEXT)
    fp_b = fingerprint({"content": "b"}, ItemKind.TEXT)
    assert fp_a != fp_b


def test_done_key_format():
    assert done_key("queue:link", "https://x.com") == "queue:link:done:https://x.com"


def test_done_ttl_is_7_days():
    assert DONE_TTL == 604800
