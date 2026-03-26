#!/usr/bin/env python3
"""
Interpolate missing timestamps in songs.json for 8 songs with partial
WhisperX alignment.

Final clean version:
- Fix original near-duplicate anchor clusters using segment boundaries
- Fill gaps between anchors proportionally, using even spacing when tight
- Handle pre/post anchor lines
- Never create 0.01s degenerate gaps (use even spacing as fallback)
- Strict monotonic ordering enforced
"""

import json
import re
import os
from typing import Optional, List, Tuple

SONGS_PATH = "/home/debian/apex/x/code/lyric/data/songs.json"
WHISPERX_DIR = "/home/debian/apex/x/code/lyric/scripts/srt-timestamps"

TARGET_IDS = [
    "ZdxvnWKa52w",
    "V8wFrVG_b0M",
    "5WYjvoY1lXk",
    "pwjMGY1lTO4",
    "WvqLiU-lWJA",
    "qhHLq8-hvuw",
    "8nJOcu0C7xU",
    "bQXkHAFMgkc",
]

MIN_GAP = 1.0


def ts2s(ts: str) -> Optional[float]:
    m = re.match(r"(\d+):(\d+)\.(\d+)", ts or "")
    if not m:
        return None
    frac = int(m.group(3)) / (10 ** len(m.group(3)))
    return int(m.group(1)) * 60 + int(m.group(2)) + frac


def s2ts(secs: float) -> str:
    secs = max(0.0, secs)
    m = int(secs // 60)
    rem = secs - m * 60
    s = int(rem)
    cs = int(round((rem - s) * 100))
    if cs >= 100: cs -= 100; s += 1
    if s >= 60: s -= 60; m += 1
    return f"{m:02d}:{s:02d}.{cs:02d}"


def nc(text: str) -> int:
    return max(1, sum(1 for c in text
                      if c.strip() and c not in "，。！？、…—～「」『』【】〔〕（）(),.!?'\"-_:;·"))


def seg_best(t1: float, t2: float, segs: List[dict]) -> Optional[dict]:
    best, bo = None, 0.0
    for s in segs:
        ov = max(0.0, min(s["end"], t2) - max(s["start"], t1))
        if ov > bo:
            bo, best = ov, s
    return best


def seg_at(t: float, segs: List[dict]) -> Optional[dict]:
    for s in segs:
        if s["start"] <= t <= s["end"]:
            return s
    return None


def place_times(n: int, chars: List[int],
                w_l: float, w_r: float) -> List[float]:
    """
    Place n lines within [w_l, w_r], proportional by chars.
    If window too tight for MIN_GAP, use even spacing.
    Applies forward MIN_GAP pass. If forward pass overflows:
      - Clips to w_r and applies backward pass
      - If backward pass hits w_l, uses even spacing (avoids 0.01s degenerate)
    Returns list of n timestamps all within [w_l, w_r].
    """
    if n == 0:
        return []
    if n == 1:
        return [(w_l + w_r) / 2]

    duration = w_r - w_l
    if duration <= 0:
        # Degenerate window: even 0-offset
        return [w_l + (k / n) * 0.01 for k in range(n)]

    # Proportional times (midpoint of each char slice)
    total = sum(chars) or n
    times = []
    cum = 0
    for ch in chars:
        frac = (cum + ch * 0.5) / total
        times.append(w_l + frac * duration)
        cum += ch

    # Forward pass: enforce MIN_GAP
    for k in range(1, n):
        if times[k] - times[k - 1] < MIN_GAP:
            times[k] = times[k - 1] + MIN_GAP

    # Check if forward pass overflowed
    if times[-1] <= w_r:
        # All good, clamp to window
        times = [max(w_l, min(w_r, t)) for t in times]
        return times

    # Forward pass overflowed: try backward pass
    times[-1] = w_r
    for k in range(n - 2, -1, -1):
        times[k] = min(times[k], times[k + 1] - MIN_GAP)

    # Check if backward pass underflowed (times[0] < w_l)
    if times[0] < w_l:
        # Window truly too tight for MIN_GAP: use even spacing
        step = duration / (n + 1)
        times = [w_l + (k + 1) * step for k in range(n)]

    # Final clamp to [w_l, w_r] and ensure increasing
    times = [max(w_l, min(w_r, t)) for t in times]
    for k in range(1, n):
        if times[k] <= times[k - 1]:
            # Can only happen if window < n * epsilon
            times[k] = times[k - 1] + (duration / n) * 0.5

    return times


def try_expand(t_l: float, t_r: float, n: int,
               segs: List[dict], hard_l: float, hard_r: float) -> Tuple[float, float]:
    """
    If [t_l, t_r] can't fit n lines with MIN_GAP, try to expand using segment boundaries.
    Returns (new_l, new_r) within [hard_l, hard_r].
    """
    needed = (n - 1) * MIN_GAP
    if t_r - t_l >= needed:
        return t_l, t_r
    seg = seg_best(t_l, t_r, segs)
    if not seg:
        return t_l, t_r
    new_l = max(hard_l, seg["start"])
    new_r = min(hard_r, seg["end"])
    if new_r - new_l >= needed:
        return new_l, new_r
    return t_l, t_r


def process_song(song: dict, wx: dict) -> Tuple[dict, str]:
    lyrics = song.get("lyrics", [])
    if not lyrics:
        return song, "no lyrics"

    segs = [{"start": s["start"], "end": s["end"]} for s in wx.get("segments", [])]
    dur = segs[-1]["end"] if segs else 300.0
    result = [dict(l) for l in lyrics]

    non_empty = [i for i, l in enumerate(result) if l.get("chinese", "") != ""]
    orig_count = sum(1 for i in non_empty if lyrics[i].get("timestamp"))
    total_ne = len(non_empty)

    print(f"  {song['id']}: {orig_count} anchors, {total_ne - orig_count} to fill")
    if not orig_count:
        return song, "no anchors"

    def get_anch() -> List[Tuple[int, float]]:
        return [(i, ts2s(result[i]["timestamp"]))
                for i in non_empty
                if result[i].get("timestamp") and ts2s(result[i]["timestamp"]) is not None]

    anch = get_anch()

    # -----------------------------------------------------------------------
    # Step 1: Fix original near-duplicate anchor clusters
    # -----------------------------------------------------------------------
    time_sorted = sorted(anch, key=lambda x: x[1])
    clusters_fixed = 0
    i = 0
    while i < len(time_sorted) - 1:
        if time_sorted[i + 1][1] - time_sorted[i][1] >= MIN_GAP:
            i += 1
            continue
        # Find full cluster
        cs = i
        ce = i + 1
        while (ce + 1 < len(time_sorted) and
               time_sorted[ce + 1][1] - time_sorted[cs][1] < MIN_GAP * (ce - cs + 1)):
            ce += 1
        cluster = time_sorted[cs:ce + 1]
        n_cl = len(cluster)
        positions = [p for p, _ in cluster]
        t_first, t_last = cluster[0][1], cluster[-1][1]

        hard_l = (time_sorted[cs - 1][1] + MIN_GAP) if cs > 0 else 0.0
        hard_r = (time_sorted[ce + 1][1] - MIN_GAP) if ce + 1 < len(time_sorted) else dur

        w_l, w_r = t_first, t_last
        needed = (n_cl - 1) * MIN_GAP
        if w_r - w_l < needed:
            w_l, w_r = try_expand(t_first, t_last, n_cl, segs, hard_l, hard_r)
            w_l = max(w_l, hard_l)
            w_r = min(w_r, hard_r)

        if w_r > w_l and n_cl > 1:
            c_chars = [nc(result[p].get("chinese", "")) for p in positions]
            times = place_times(n_cl, c_chars, w_l, w_r)
            for k, pos in enumerate(positions):
                clamped = max(hard_l, min(hard_r, times[k]))
                result[pos]["timestamp"] = s2ts(clamped)
                for idx in range(len(time_sorted)):
                    if time_sorted[idx][0] == pos:
                        time_sorted[idx] = (pos, clamped)
                        break
            clusters_fixed += 1
        i = ce + 1

    if clusters_fixed:
        print(f"    Fixed {clusters_fixed} cluster(s)")

    # Rebuild anchors
    anch = get_anch()

    # -----------------------------------------------------------------------
    # Step 2: Fill gaps between consecutive anchors (by POSITION order)
    # -----------------------------------------------------------------------
    for ai in range(len(anch) - 1):
        left_pos, left_t = anch[ai]
        right_pos, right_t = anch[ai + 1]

        if right_t <= left_t:
            continue

        gap = [i for i in non_empty
               if left_pos < i < right_pos and not result[i].get("timestamp")]
        if not gap:
            continue

        n_gap = len(gap)
        gap_chars = [nc(result[i].get("chinese", "")) for i in gap]

        # Window bounds
        left_chars = nc(result[left_pos].get("chinese", ""))
        right_chars = nc(result[right_pos].get("chinese", ""))
        total_c = left_chars + sum(gap_chars) + right_chars
        span = right_t - left_t

        if total_c > 0:
            w_l = left_t + (left_chars / total_c) * span
            w_r = right_t - (right_chars / total_c) * span
        else:
            w_l = left_t + span / (n_gap + 2)
            w_r = right_t - span / (n_gap + 2)

        w_l = max(w_l, left_t + 0.01)
        w_r = min(w_r, right_t - 0.01)

        # Expand if too tight
        needed = (n_gap - 1) * MIN_GAP if n_gap > 1 else 0.0
        if w_r - w_l < needed:
            new_l, new_r = try_expand(left_t, right_t, n_gap, segs, left_t, right_t)
            w_l = max(w_l, new_l + 0.01)
            w_r = min(w_r, new_r - 0.01)

        if w_l >= w_r:
            w_l = left_t + 0.01
            w_r = right_t - 0.01
        if w_l >= w_r:
            continue

        times = place_times(n_gap, gap_chars, w_l, w_r)
        for k, li in enumerate(gap):
            t = max(left_t + 0.01, min(right_t - 0.01, times[k]))
            result[li]["timestamp"] = s2ts(t)

    # Rebuild
    anch = get_anch()

    # -----------------------------------------------------------------------
    # Step 3: Lines BEFORE first anchor
    # -----------------------------------------------------------------------
    first_pos, first_t = anch[0]
    pre = [i for i in non_empty if i < first_pos and not result[i].get("timestamp")]

    if pre:
        n_pre = len(pre)
        pre_chars = [nc(result[i].get("chinese", "")) for i in pre]

        seg = seg_at(first_t, segs) or seg_best(0.0, first_t, segs)
        seg_l = seg["start"] if seg else 0.0

        w_r = first_t - 0.01
        w_l = max(0.0, seg_l)
        needed = (n_pre - 1) * MIN_GAP if n_pre > 1 else 0.0
        if w_r - w_l < needed:
            w_l = max(0.0, w_r - (n_pre + 1) * MIN_GAP)
        if w_l >= w_r:
            w_l = max(0.0, w_r - 0.1)

        if w_l < w_r:
            times = place_times(n_pre, pre_chars, w_l, w_r)
            for k, li in enumerate(pre):
                result[li]["timestamp"] = s2ts(max(0.0, min(first_t - 0.01, times[k])))

    # -----------------------------------------------------------------------
    # Step 4: Lines AFTER last anchor
    # -----------------------------------------------------------------------
    anch = get_anch()
    last_pos, last_t = anch[-1]
    post = [i for i in non_empty if i > last_pos and not result[i].get("timestamp")]

    if post:
        n_post = len(post)
        post_chars = [nc(result[i].get("chinese", "")) for i in post]

        seg = seg_at(last_t, segs)
        if seg:
            seg_r = seg["end"]
        else:
            segs_after = [s for s in segs if s["start"] > last_t]
            seg_r = segs_after[0]["end"] if segs_after else min(dur, last_t + 30)

        w_l = last_t + 0.01
        w_r = min(dur, seg_r)
        needed = (n_post - 1) * MIN_GAP if n_post > 1 else 0.0
        if w_r - w_l < needed:
            w_r = min(dur, w_l + (n_post + 1) * MIN_GAP)
        if w_l >= w_r:
            w_r = w_l + 1.0

        times = place_times(n_post, post_chars, w_l, w_r)
        for k, li in enumerate(post):
            result[li]["timestamp"] = s2ts(max(last_t + 0.01, min(dur, times[k])))

    final_ts = sum(1 for l in result if l.get("chinese", "") != "" and l.get("timestamp"))
    added = final_ts - orig_count
    summary = f"{orig_count} -> {final_ts}/{total_ne} (+{added})"
    print(f"  -> {summary}")

    updated = dict(song)
    updated["lyrics"] = result
    return updated, summary


def main():
    print("Loading songs.json...")
    with open(SONGS_PATH) as f:
        songs = json.load(f)
    song_map = {s["id"]: idx for idx, s in enumerate(songs)}
    changes = []

    for song_id in TARGET_IDS:
        if song_id not in song_map:
            continue
        wx_path = os.path.join(WHISPERX_DIR, f"{song_id}.json")
        if not os.path.exists(wx_path):
            continue
        with open(wx_path) as f:
            wx = json.load(f)
        song = songs[song_map[song_id]]
        print(f"\nProcessing: {song['title']} ({song_id})")
        updated, summary = process_song(song, wx)
        songs[song_map[song_id]] = updated
        changes.append((song_id, song["title"], summary))

    print("\n" + "=" * 60)
    print("SUMMARY:")
    for _, title, summary in changes:
        print(f"  {title}")
        print(f"    {summary}")
    print("\nWriting songs.json...")
    with open(SONGS_PATH, "w") as f:
        json.dump(songs, f, ensure_ascii=False, indent=2)
    print("Done.")


if __name__ == "__main__":
    main()
