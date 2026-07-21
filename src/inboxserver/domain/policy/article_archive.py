"""文章归档领域规则：URL 预排除、正文验收、命名和元数据规范化。"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import PurePosixPath
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
MAX_FILENAME_LENGTH = 120

_EXCLUDED_HOSTS = (
    "bilibili.com",
    "douyin.com",
    "github.com",
    "gitlab.com",
    "tiktok.com",
    "vimeo.com",
    "youtu.be",
    "youtube.com",
)
_DOWNLOAD_SUFFIXES = {
    ".7z",
    ".apk",
    ".dmg",
    ".doc",
    ".docx",
    ".epub",
    ".exe",
    ".gz",
    ".iso",
    ".mp3",
    ".mp4",
    ".pdf",
    ".ppt",
    ".pptx",
    ".rar",
    ".tar",
    ".wav",
    ".xls",
    ".xlsx",
    ".zip",
}
_ERROR_MARKERS = (
    "访问过于频繁",
    "当前请求存在异常",
    "环境异常",
    "请完成验证",
    "Unable to access",
    "Access Denied",
    "This content is not available",
)
_MARKDOWN_LINK = re.compile(r"!?\[([^]]*)]\([^)]+\)")
_HTML_TAG = re.compile(r"<[^>]+>")
_FRONTMATTER = re.compile(r"\A---\s*\n.*?\n---\s*\n", re.DOTALL)


@dataclass(frozen=True)
class DefuddleArticle:
    """Defuddle 返回的结构化文章结果。"""

    title: str
    markdown: str
    author: str = ""
    published_at: str = ""


@dataclass(frozen=True)
class ArticleAssessment:
    """正文验收结果；无效原因用于结构化日志和正常跳过。"""

    valid: bool
    visible_characters: int
    reason: str | None


def url_fingerprint(url: str, length: int = 10) -> str:
    """生成稳定短指纹，用于文件名兜底和脱敏日志。"""
    return hashlib.sha256(url.encode()).hexdigest()[:length]


def preexclude_reason(url: str) -> str | None:
    """返回确定的非文章原因；返回 None 表示需要继续按内容识别。"""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return "unsupported_scheme"
    hostname = parsed.hostname.lower()
    if any(hostname == host or hostname.endswith(f".{host}") for host in _EXCLUDED_HOSTS):
        return "excluded_host"
    if PurePosixPath(parsed.path.lower()).suffix in _DOWNLOAD_SUFFIXES:
        return "download_file"
    return None


def assess_article(
    article: DefuddleArticle,
    *,
    min_visible_characters: int,
) -> ArticleAssessment:
    """按标题、错误页标记和可见字数验收 Defuddle 结果。"""
    markdown = article.markdown.strip()
    visible = _FRONTMATTER.sub("", markdown)
    visible = _MARKDOWN_LINK.sub(r"\1", visible)
    visible = _HTML_TAG.sub(" ", visible)
    visible_characters = sum(1 for char in visible if char.isalnum())
    if any(marker.casefold() in markdown.casefold() for marker in _ERROR_MARKERS):
        return ArticleAssessment(False, visible_characters, "error_marker")
    if not article.title.strip():
        return ArticleAssessment(False, visible_characters, "missing_title")
    if visible_characters < min_visible_characters:
        return ArticleAssessment(False, visible_characters, "short_content")
    return ArticleAssessment(True, visible_characters, None)


def archive_date(moment: datetime | None = None) -> str:
    """按 Asia/Shanghai 自然日生成 YYYYMMDD 归档日期。"""
    current = moment or datetime.now(UTC)
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)
    return current.astimezone(SHANGHAI).strftime("%Y%m%d")


def sanitize_title(title: str) -> str:
    """NFKC 规范化后仅保留 Unicode 字母和数字，移除全部空白和特殊字符。"""
    normalized = unicodedata.normalize("NFKC", title)
    return "".join(char for char in normalized if char.isalnum())


def build_archive_filename(url: str, title: str, moment: datetime | None = None) -> str:
    """生成长度受限、无空白和特殊字符的确定性 Obsidian 文件名。"""
    prefix = f"{archive_date(moment)}-"
    suffix = ".md"
    max_stem_length = MAX_FILENAME_LENGTH - len(prefix) - len(suffix)
    safe_title = sanitize_title(title)[:max_stem_length]
    if not safe_title:
        host = sanitize_title(urlparse(url).hostname or "article") or "article"
        digest = url_fingerprint(url)
        safe_title = f"{host}-{digest}"[:max_stem_length]
    return f"{prefix}{safe_title}{suffix}"


def normalize_archive_metadata(
    *,
    title: str,
    source_url: str,
    archived_at: datetime,
    author: str | None,
    published_at: str | None,
    tags: list[str] | None,
) -> dict[str, str | list[str]]:
    """生成稳定 frontmatter 字段，并对标签去空、去重、保持原序。"""
    moment = archived_at if archived_at.tzinfo else archived_at.replace(tzinfo=UTC)
    unique_tags: list[str] = []
    for raw in tags or []:
        tag = raw.strip()
        if tag and tag not in unique_tags:
            unique_tags.append(tag)
    return {
        "title": title.strip(),
        "source_url": source_url,
        "archived_at": moment.astimezone(SHANGHAI).isoformat(),
        "author": (author or "").strip(),
        "published_at": (published_at or "").strip(),
        "tags": unique_tags,
    }
