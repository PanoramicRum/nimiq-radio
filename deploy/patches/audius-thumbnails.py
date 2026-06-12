#!/usr/bin/env python3
"""
Vendored fix for yt-dlp's Audius extractor.

Audius added a `mirrors` key (a list of mirror hosts) to a track's `artwork` object. The extractor
loops over every artwork entry and emits a thumbnail with `url=<value>`, so for `mirrors` it produces
a thumbnail whose `url` is a list — and yt-dlp's core then crashes in `sanitize_url`:
    ERROR: 'list' object has no attribute 'startswith'
…breaking ALL Audius downloads. The fix is to skip non-URL artwork values (`url_or_none`).

This patches the INSTALLED yt-dlp in place at image-build time. It is idempotent and never fails the
build: once a yt-dlp release includes the upstream fix, the needle no longer matches and this no-ops.
Upstream PR: https://github.com/yt-dlp/yt-dlp (see deploy notes).
"""
import pathlib
import re
import sys

try:
    import yt_dlp.extractor.audius as mod
except Exception as e:  # noqa: BLE001
    print(f"audius patch: yt-dlp not importable ({e}); skipping")
    sys.exit(0)

path = pathlib.Path(mod.__file__)
src = path.read_text()

if "if not url_or_none(thumbnail_url):" in src:
    print("audius patch: already applied")
    sys.exit(0)

needle = "            for quality_key, thumbnail_url in artworks_data.items():\n                thumbnail = {"
if needle not in src:
    print("audius patch: artwork loop not found (yt-dlp changed / already fixed upstream); skipping")
    sys.exit(0)

if "url_or_none" not in src:
    if "from ..utils import (" in src:
        src = src.replace("from ..utils import (", "from ..utils import (\n    url_or_none,", 1)
    else:
        src = re.sub(r"(from \.\.utils import )(.*)", r"\1url_or_none, \2", src, count=1)

replacement = (
    "            for quality_key, thumbnail_url in artworks_data.items():\n"
    "                if not url_or_none(thumbnail_url):\n"
    "                    continue  # skip non-URL artwork entries (e.g. Audius' 'mirrors' list)\n"
    "                thumbnail = {"
)
path.write_text(src.replace(needle, replacement, 1))
print(f"audius patch: applied to {path}")
