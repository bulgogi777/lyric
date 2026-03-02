#!/usr/bin/env python3
"""
align-timestamps.py

Aligns WhisperX word-level timestamps to existing lyrics in songs.json.

Strategy:
  - Build a flat list of (char, start_time) from word_segments (Chinese chars only)
  - For each lyric line, find the best matching position by:
    1. First try local window (search_pos + MAX_LOOKAHEAD)
    2. If score is too low, do a global search (full timeline from search_pos onward)
  - Use sliding-window fuzzy matching on first N chars of each line
  - Process sequentially (never go backwards)
  - Handle simplified/traditional variance via character normalization

Usage: python3 scripts/align-timestamps.py
"""

import json
import unicodedata
from pathlib import Path
from typing import Optional

# ─── Config ────────────────────────────────────────────────────────────────────

SONGS_JSON = Path("/home/debian/apex/x/code/lyric/data/songs.json")
SRT_DIR    = Path("/home/debian/apex/x/code/lyric/scripts/srt-timestamps")

TARGET_IDS = [
    "x6Kgp734eZo",   # 我超喜欢你
]

# Chars to use for probe matching
MATCH_CHARS = 4

# Local lookahead: try this many positions first
LOCAL_LOOKAHEAD = 40

# Minimum score fraction to accept a local match (avoid false positives)
# Local: 0.5 = at least 50% of probe chars match (more lenient, position is already constrained)
# Global: 0.75 = stricter since we search the entire remaining timeline
LOCAL_MIN_SCORE_FRACTION  = 0.5
GLOBAL_MIN_SCORE_FRACTION = 0.75

# ─── Traditional/Simplified normalization map ──────────────────────────────────
# Common pairs that appear in lyrics but differ between Whisper output and our data
# Format: {traditional: simplified}
TRAD_TO_SIMP = {
    '聽': '听', '話': '话', '媽': '妈', '書': '书', '為': '为',
    '麼': '么', '別': '别', '學': '学', '畫': '画', '鋼': '钢',
    '琴': '琴', '說': '说', '對': '对', '遊': '游', '戲': '戏',
    '靠': '靠', '場': '场', '電': '电', '機': '机', '錄': '录',
    '讓': '让', '傷': '伤', '長': '长', '發': '发', '們': '们',
    '歡': '欢', '兒': '儿', '點': '点', '開': '开', '從': '从',
    '還': '还', '這': '这', '會': '会', '時': '时', '見': '见',
    '邊': '边', '當': '当', '頭': '头', '面': '面', '來': '来',
    '過': '过', '樂': '乐', '歌': '歌', '愛': '爱', '夢': '梦',
    '飛': '飞', '帶': '带', '與': '与', '愛': '爱', '幸': '幸',
    '髮': '发', '慈': '慈', '嫩': '嫩', '準': '准', '備': '备',
    '訪': '访', '採': '采', '應': '应', '該': '该', '無': '无',
    '牆': '墙', '壁': '壁', '齊': '齐', '眾': '众', '寫': '写',
    '媽': '妈', '個': '个', '沒': '没', '號': '号', '問': '问',
    '積': '积', '極': '极', '難': '难', '換': '换', '親': '亲',
    '關': '关', '緊': '紧', '哦': '哦', '啊': '啊',
    # acaSDkqAKPA specific
    '裂': '裂', '縫': '缝', '崖': '崖', '攀': '攀', '爬': '爬',
    '絕': '绝', '仰': '仰', '宣': '宣', '告': '告', '穿': '穿',
    '越': '越', '暗': '暗', '掀': '掀', '遮': '遮', '掩': '掩',
    '靈': '灵', '幕': '幕', '恩': '恩', '典': '典', '結': '结',
    '局': '局', '赦': '赦', '免': '免', '萬': '万', '稱': '称',
    '屬': '属', '榮': '荣', '美': '美', '救': '救', '哈': '哈',
    '利': '利', '釋': '释', '放': '放', '破': '破', '碎': '碎',
    '枷': '枷', '鎖': '锁', '贖': '赎', '應': '应', '許': '许',
    '葬': '葬', '沉': '沉', '寂': '寂', '咆': '咆', '哮': '哮',
    '獅': '狮', '墳': '坟', '墓': '墓', '轄': '辖', '制': '制',
    '耶': '耶', '稣': '稣', '全': '全', '然': '然', '勝': '胜',
    # uXTOLzpJk5Q specific
    '祢': '祢', '太': '太', '初': '初', '道': '道', '至': '至',
    '高': '高', '造': '造', '物': '物', '隱': '隐', '藏': '藏',
    '顯': '显', '明': '明', '督': '督', '荣': '荣', '王': '王',
    '基': '基', '督': '督', '聖': '圣', '等': '等', '比': '比',
    '享': '享', '堂': '堂', '降': '降', '臨': '临', '罪': '罪',
    '雖': '虽', '重': '重', '深': '深', '永': '永', '離': '离',
    '死': '死', '困': '困', '幔': '幔', '子': '子', '挪': '挪',
    '間': '间', '屈': '屈', '服': '服', '復': '复', '活': '活',
    '匹': '匹', '敵': '敌', '掌': '掌', '權': '权', '直': '直',
    '國': '国', '度': '度', '超': '超', '乎': '乎',
}

# Build reverse map too
SIMP_TO_TRAD = {v: k for k, v in TRAD_TO_SIMP.items() if v != k}


def normalize_char(ch: str) -> str:
    """
    Normalize a character for comparison:
    - NFKC unicode normalization
    - Collapse trad/simp variants to a canonical form
    """
    ch = unicodedata.normalize('NFKC', ch)
    # Map both to simplified for comparison
    return TRAD_TO_SIMP.get(ch, ch)


def is_chinese(ch: str) -> bool:
    return '\u4e00' <= ch <= '\u9fff' or '\u3400' <= ch <= '\u4dbf'


def extract_chinese_chars(text: str) -> list[str]:
    return [ch for ch in text if is_chinese(ch)]


def format_timestamp(seconds: float) -> str:
    minutes = int(seconds // 60)
    secs    = seconds % 60
    return f"{minutes:02d}:{secs:05.2f}"


def build_char_timeline(word_segments: list[dict]) -> list[tuple[str, float]]:
    """
    Build flat list of (normalized_chinese_char, start_time).
    Skips non-Chinese entries.
    """
    timeline: list[tuple[str, float]] = []
    for seg in word_segments:
        word  = seg.get("word", "")
        start = seg.get("start", 0.0)
        for ch in word:
            if is_chinese(ch):
                timeline.append((normalize_char(ch), start))
    return timeline


def score_at(probe: list[str], timeline: list[tuple[str, float]], pos: int) -> int:
    """
    Score matching probe against timeline starting at pos.
    Returns count of matched chars (allows partial: probe chars that don't match are skipped).
    """
    score = 0
    t_idx = pos
    for p_ch in probe:
        if t_idx >= len(timeline):
            break
        t_ch = timeline[t_idx][0]
        if normalize_char(p_ch) == t_ch:
            score += 1
        t_idx += 1
    return score


def find_best_match(
    probe: list[str],
    timeline: list[tuple[str, float]],
    search_start: int,
    search_end: int,
) -> tuple[int, int]:
    """
    Find position in [search_start, search_end) that best matches probe.
    Returns (best_pos, best_score).
    """
    best_pos   = -1
    best_score = 0

    for pos in range(search_start, min(search_end, len(timeline))):
        s = score_at(probe, timeline, pos)
        if s > best_score:
            best_score = s
            best_pos   = pos

    return best_pos, best_score


def find_line_timestamp(
    lyric_chinese: str,
    timeline: list[tuple[str, float]],
    search_start: int,
) -> tuple[Optional[float], int]:
    """
    Find best timestamp for a lyric line, searching from search_start.

    Returns (timestamp_seconds or None, new_search_start).
    """
    lyric_chars = [normalize_char(c) for c in extract_chinese_chars(lyric_chinese)]

    if not lyric_chars:
        return None, search_start

    probe     = lyric_chars[:MATCH_CHARS]
    probe_len = len(probe)
    local_min  = max(1, int(probe_len * LOCAL_MIN_SCORE_FRACTION))
    global_min = max(2, int(probe_len * GLOBAL_MIN_SCORE_FRACTION))

    # Phase 1: Local window search
    local_end = search_start + LOCAL_LOOKAHEAD
    best_pos, best_score = find_best_match(probe, timeline, search_start, local_end)

    accepted_min = local_min  # threshold for accepting the result

    # Phase 2: If local didn't find a good match, do global search from search_start
    # Use stricter threshold for global to avoid false positives
    if best_score < local_min:
        global_end = len(timeline)
        global_pos, global_score = find_best_match(probe, timeline, search_start, global_end)
        if global_score > best_score:
            best_pos   = global_pos
            best_score = global_score
        accepted_min = global_min  # stricter threshold for global matches

    if best_score >= accepted_min and best_pos >= 0:
        ts_secs   = timeline[best_pos][1]
        new_start = best_pos + len(lyric_chars)
        new_start = min(new_start, len(timeline))
        return ts_secs, new_start
    else:
        # No match: advance minimally
        return None, search_start + 1


# ─── Main ──────────────────────────────────────────────────────────────────────

def align_song(song: dict) -> dict:
    song_id   = song["id"]
    title     = song.get("title", song_id)
    json_path = SRT_DIR / f"{song_id}.json"

    if not json_path.exists():
        print(f"  [SKIP] No WhisperX JSON: {json_path}")
        return {"song_id": song_id, "title": title, "matched": 0, "unmatched": 0, "skipped": 0}

    with open(json_path, encoding="utf-8") as f:
        whisper_data = json.load(f)

    word_segments = whisper_data.get("word_segments", [])
    if not word_segments:
        print(f"  [SKIP] No word_segments in {json_path}")
        return {"song_id": song_id, "title": title, "matched": 0, "unmatched": 0, "skipped": 1}

    timeline = build_char_timeline(word_segments)
    print(f"  Timeline chars: {len(timeline)}, time range: {timeline[0][1]:.2f}s – {timeline[-1][1]:.2f}s")

    lyrics   = song.get("lyrics", [])
    matched  = 0
    unmatched = 0
    skipped  = 0

    search_pos = 0

    for i, line in enumerate(lyrics):
        chinese = line.get("chinese", "")

        # Skip empty separator lines
        if not chinese.strip():
            skipped += 1
            continue

        # Skip already-timestamped lines
        if line.get("timestamp"):
            matched += 1
            continue

        ts_secs, search_pos = find_line_timestamp(chinese, timeline, search_pos)

        if ts_secs is not None:
            line["timestamp"] = format_timestamp(ts_secs)
            matched += 1
            print(f"    [{i:2d}] {format_timestamp(ts_secs)} | {repr(chinese[:24])}")
        else:
            unmatched += 1
            print(f"    [{i:2d}] NO_MATCH         | {repr(chinese[:24])}")

    return {
        "song_id":  song_id,
        "title":    title,
        "matched":  matched,
        "unmatched": unmatched,
        "skipped":  skipped,
    }


def main():
    print(f"Loading {SONGS_JSON} ...")
    with open(SONGS_JSON, encoding="utf-8") as f:
        songs = json.load(f)

    songs_by_id = {s["id"]: s for s in songs}
    all_stats   = []

    for song_id in TARGET_IDS:
        song = songs_by_id.get(song_id)
        if not song:
            print(f"Song {song_id} not found in songs.json")
            continue

        print(f"\n{'='*60}")
        print(f"Processing: {song.get('title', song_id)} ({song_id})")
        print(f"{'='*60}")

        stats = align_song(song)
        all_stats.append(stats)

    # Write back
    print(f"\n\nWriting updated songs.json ...")
    with open(SONGS_JSON, "w", encoding="utf-8") as f:
        json.dump(songs, f, ensure_ascii=False, indent=2)

    # Summary
    print("\n" + "="*60)
    print("ALIGNMENT SUMMARY")
    print("="*60)
    for s in all_stats:
        total = s["matched"] + s["unmatched"] + s["skipped"]
        pct   = (100 * s["matched"] / (s["matched"] + s["unmatched"])
                 if (s["matched"] + s["unmatched"]) > 0 else 0)
        print(f"\n  {s['title']} ({s['song_id']})")
        print(f"    Total lines    : {total}")
        print(f"    Matched        : {s['matched']}")
        print(f"    Unmatched      : {s['unmatched']}")
        print(f"    Skipped (empty): {s['skipped']}")
        print(f"    Match rate     : {pct:.1f}%")

    print("\nDone.")


if __name__ == "__main__":
    main()
