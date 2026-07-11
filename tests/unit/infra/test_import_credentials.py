"""import_credentials 凭据提取测试。"""

from scripts.import_credentials import extract_credentials


def test_extract_credentials_includes_x_storage_state():
    state = {
        "cookies": [
            {"name": "auth_token", "value": "t", "domain": ".x.com"},
            {"name": "ct0", "value": "c", "domain": ".twitter.com"},
            {"name": "other", "value": "n", "domain": ".example.com"},
        ],
        "origins": [
            {"origin": "https://x.com", "localStorage": [{"name": "k", "value": "v"}]},
            {"origin": "https://example.com", "localStorage": []},
        ],
    }

    creds = extract_credentials(state)

    assert creds["x_creds"]["platform"] == "x"
    assert creds["x_creds"]["kind"] == "session"
    storage_state = creds["x_creds"]["payload"]["storage_state"]
    assert [c["name"] for c in storage_state["cookies"]] == ["auth_token", "ct0"]
    assert [o["origin"] for o in storage_state["origins"]] == ["https://x.com"]
