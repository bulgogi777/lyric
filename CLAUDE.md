# CLAUDE.md - Chinese Lyrics Study Tool

## Project Overview

A web app for studying Chinese through music. Displays song lyrics with Chinese characters, pinyin romanization, and English translations alongside embedded YouTube videos.

**Live Site:** https://lyric.bwe4.net
**GitHub:** https://github.com/bulgogi777/lyric

## Tech Stack

- **Framework:** Astro v5 (static site generation)
- **Styling:** Tailwind CSS v4
- **Pinyin:** pinyin-pro library
- **Package Manager:** bun (NOT npm/yarn)
- **Deployment:** Vercel (auto-deploys on push to master)
- **Data Storage:** Local JSON file (`data/songs.json`)

## Key Commands

```bash
bun run dev      # Start dev server
bun run build    # Build for production
bun run preview  # Preview production build
bun run data     # Rebuild data from LRCLIB (scripts/build-data.ts)
bun run validate # Quality check all songs (exits 1 on errors)
bun run sync     # Sync playlist from YouTube Music
```

## Project Structure

```
lyric/
├── data/
│   └── songs.json           # All song data + lyrics (primary data store)
├── src/
│   ├── components/
│   │   ├── LyricsDisplay.astro   # Lyrics with Chinese/pinyin/English
│   │   ├── YouTubePlayer.astro   # Embedded YouTube player
│   │   └── SongCard.astro        # Playlist card component
│   ├── layouts/
│   │   └── Layout.astro          # Base layout with nav + print styles
│   ├── pages/
│   │   ├── index.astro           # Playlist view
│   │   ├── song/[id].astro       # Song view with player + lyrics
│   │   └── admin/[id].astro      # Lyrics editor
│   └── styles/
│       └── global.css            # Tailwind + print styles
├── scripts/
│   ├── build-data.ts             # LRCLIB fetch + Gemini translation
│   ├── sync-playlist.ts          # YouTube Music playlist sync (via Tower)
│   ├── align-timestamps.py       # WhisperX timestamp alignment script
│   ├── validate.ts               # Quality validation (bun run validate)
│   ├── add-segments-sonnet.ts    # Word segmentation via Claude CLI (⚠️ see Known Constraints)
│   ├── add-segments-groq.ts      # Word segmentation via Groq (poor quality, not recommended)
│   └── srt-timestamps/           # WhisperX JSON output files (gitignored)
```

## Data Schema

```typescript
interface Song {
  id: string;                    // YouTube video ID
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  hasLyrics: boolean;
  lyricsSource?: 'lrclib' | 'manual' | 'jspinyin';
  lyrics?: LyricLine[];
}

interface LyricLine {
  timestamp?: string;            // "MM:SS.ss" format (optional)
  chinese: string;
  pinyin: string;
  english: string;
  segments?: Segment[];          // Word-segmented data for ruby alignment
}

interface Segment {
  hanzi: string;                 // Chinese character(s) for this word
  pinyin: string;                // Pinyin for this word (no spaces)
}
```

## Core Workflows

### 1. Adding Lyrics from LRCLIB

The build-data script fetches lyrics automatically:

```bash
bun run data
```

This:
1. Queries LRCLIB API for each song
2. Processes lyrics with Gemini CLI for pinyin/translation
3. Updates `data/songs.json`

### 2. Adding Lyrics with Claude (Preferred for Manual Entry)

When LRCLIB doesn't have a song:

1. **Find Chinese lyrics** from any source (copy/paste raw text)
2. **Claude generates inline** (no scripts needed):
   - Pinyin romanization
   - English translation
   - **Word segments** for ruby alignment (see below)
   - Full JSON for songs.json
3. **Check LRCLIB for timestamps** (song may have been added since):
   ```bash
   curl -s "https://lrclib.net/api/search?artist_name=ARTIST&track_name=TITLE" | jq '.[0].syncedLyrics'
   ```
4. **If no LRCLIB timestamps**, use WhisperX (see Workflow 5)
5. **Validate** (see Workflow 7), then build and push

**Word Segmentation for Ruby Alignment:**

Each lyric line should include a `segments` array that breaks the line into word units:

```json
{
  "chinese": "愛情的起點 都是最美的瞬間",
  "pinyin": "ài qíng de qǐ diǎn dōu shì zuì měi de shùn jiān",
  "english": "The beginning of love is always the most beautiful moment",
  "segments": [
    { "hanzi": "愛情", "pinyin": "àiqíng" },
    { "hanzi": "的", "pinyin": "de" },
    { "hanzi": "起點", "pinyin": "qǐdiǎn" },
    { "hanzi": " ", "pinyin": "" },
    { "hanzi": "都是", "pinyin": "dōushì" },
    { "hanzi": "最美", "pinyin": "zuìměi" },
    { "hanzi": "的", "pinyin": "de" },
    { "hanzi": "瞬間", "pinyin": "shùnjiān" }
  ]
}
```

**Segmentation rules:**
- Multi-character words stay together (愛情, 瞬間, 起點)
- Single-character grammatical words are separate (的, 是, 我)
- Spaces in the original text become `{ "hanzi": " ", "pinyin": "" }`
- Punctuation becomes `{ "hanzi": "，", "pinyin": "" }`
- Idioms and four-character expressions stay together (刻骨銘心, 念念不忘)

**Note:** Manual entry will NOT have timestamps unless LRCLIB has them or WhisperX generates them.

### 3. Adding Lyrics via jspinyin.net

Alternative source when you need pinyin:

1. **Find lyrics** on https://jspinyin.net (search for song title)
2. **Extract** Chinese characters and pinyin from the page
3. **Translate** Chinese to English (Claude can do this)
4. **Update songs.json** with the lyrics array
5. **Build and push**

### 4. Using the Admin Editor

1. Navigate to `/admin/[youtube-id]`
2. Edit lyrics directly in the UI
3. Click "Copy JSON" to get the lyrics array
4. Paste into `data/songs.json` and rebuild

### 5. Generating Timestamps via WhisperX (When LRCLIB Unavailable)

When LRCLIB doesn't have timestamps, use WhisperX on Tower for word-level timestamps:

**Prerequisites:**
- WhisperX ASR service on Tower (`http://tower:9000/asr`, engine=whisperx, large-v3, GPU)
- yt-dlp on Tower (`/root/.local/bin/yt-dlp`)

**Process:**

1. **Download audio on Tower** (YouTube blocks datacenter IPs, Tower has residential):
   ```bash
   ssh tower "/root/.local/bin/yt-dlp -x -o '/tmp/VIDEOID.%(ext)s' 'https://youtube.com/watch?v=VIDEOID'"
   ```

2. **Transcribe with WhisperX** (Chinese, JSON output for word-level timestamps):
   ```bash
   ssh tower "curl -s -X POST 'http://localhost:9000/asr?language=zh&output=json' \
     -F 'audio_file=@/tmp/VIDEOID.webm'" > scripts/srt-timestamps/VIDEOID.json
   ```

   The JSON output includes `word_segments` with per-word start/end times:
   ```json
   {"word_segments": [{"word": "愛情", "start": 13.5, "end": 14.1}, ...]}
   ```

3. **Automated alignment** via `align-timestamps.py`:
   ```bash
   python3 scripts/align-timestamps.py
   ```

   The script:
   - Builds a character-level timeline from WhisperX word_segments
   - Fuzzy-matches each lyric line's first N characters against the timeline
   - Handles traditional/simplified character normalization
   - Assigns timestamps in `MM:SS.ss` format to `data/songs.json`

   **Edit `TARGET_IDS` in the script** to select which songs to process.

4. **Review alignment quality** — Match rates vary by song type:
   - Clean worship/ballads: ~85-90% match rate
   - Fast rap/complex vocals: ~20-50% (needs manual timestamp review)
   - Unmatched lines print `NO_MATCH` in output for manual attention

5. **Clean up Tower:**
   ```bash
   ssh tower "rm /tmp/VIDEOID.webm"
   ```

**Batch processing (multiple songs):**
```bash
# Download all
ssh tower 'for id in ID1 ID2 ID3; do
  /root/.local/bin/yt-dlp -x -o "/tmp/lyrics/${id}.%(ext)s" "https://youtube.com/watch?v=${id}"
done'

# Transcribe all (JSON output)
ssh tower 'for f in /tmp/lyrics/*.webm; do
  id=$(basename "$f" .webm)
  curl -s -X POST "http://localhost:9000/asr?language=zh&output=json" -F "audio_file=@${f}" > "/tmp/lyrics/${id}.json"
done'

# Copy locally and clean up
scp tower:/tmp/lyrics/*.json scripts/srt-timestamps/
ssh tower "rm -rf /tmp/lyrics"
```

**WhisperX files location:** `scripts/srt-timestamps/` (gitignored, temporary working files)

**Why JSON over SRT:** Word-level timestamps enable character-by-character alignment via `align-timestamps.py`. SRT only gives sentence-level timing and requires manual matching.

**When WhisperX coverage is partial (common for pop songs):**

WhisperX often captures only 50-60% of characters in songs with instrumental breaks or processed vocals. Use **anchor + interpolation**:

1. Run WhisperX and `align-timestamps.py` to get anchor timestamps
2. Identify the song structure (verse/chorus/bridge sections from the lyrics)
3. Use verse 1 timing pattern (usually well-captured) as a template
4. Apply the pattern offsets to each repeated section, starting at the anchor point
5. Run `bun run validate SONG_ID` to catch near-duplicates, large gaps, or ordering issues

**Audio conversion (required — yt-dlp on Tower lacks ffmpeg):**
```bash
# Use Docker ffmpeg to convert webm → WAV (16kHz mono, optimal for Whisper)
ssh tower "docker run --rm -v /tmp:/tmp jrottenberg/ffmpeg \
  -i /tmp/VIDEOID.webm -vn -acodec pcm_s16le -ar 16000 -ac 1 /tmp/VIDEOID.wav"
```

### 6. Quality Validation (Before Commit)

Run the validation script:

```bash
bun run validate              # All songs (exits 1 if errors found)
bun run validate SONG_ID      # Specific song by ID or title substring
bun run validate --summary    # Summary only (no per-line details)
```

**Checks performed:**
- **Missing fields**: translations, segments, timestamps
- **Segment consistency**: reconstructed hanzi must match chinese (with quote/whitespace normalization)
- **Malformed segments**: missing hanzi/pinyin keys
- **Timestamp anomalies**:
  - Near-duplicates (< 1s gap between consecutive lines)
  - Large gaps (> 20s between consecutive lines)
  - Out-of-order timestamps
  - Exceeds song duration
- **LLM noise**: patterns like "I will check", "directory", backtick code refs
- **Bilingual detection**: non-Chinese content (English, Thai, Japanese)

**Error vs Warning:**
- Errors (✗): Data problems that should be fixed (missing segments, bad translations, segment mismatches)
- Warnings (△): Things to be aware of (bilingual lines, large timestamp gaps from instrumental breaks, missing timestamps)

**Expected warnings (not bugs):**
- Bilingual songs (E.SO, Joyce Chu) will flag non-Chinese lines — these are correct
- Large timestamp gaps often indicate instrumental breaks — verify against the actual song
- Near-duplicate timestamps can be valid for fast-delivery sections

### 7. Fixing Translation Issues

The `LyricsDisplay.astro` component has a filter to hide LLM-generated noise:

```typescript
// In src/components/LyricsDisplay.astro
function isValidTranslation(text: string): boolean {
  const errorPatterns = [
    /^I will check/i,
    /^I will read/i,
    /^I will need/i,
    /^I'll check/i,
    /^I'll read/i,
    /\.md`/,
    /`.*`/,
    /directory/i,
    /existing translation/i,
    /check.*translation/i,
    /read.*to understand/i,
  ];
  return !errorPatterns.some(p => p.test(text));
}
```

**Important:** Be careful not to make patterns too broad - `/^I will/i` would hide valid translations like "I will continue, please get ready".

## YouTube Integration

- **Embedding:** Uses YouTube IFrame API (loaded in `YouTubePlayer.astro`)
- **Seek:** `window.seekToTime(seconds)` function available globally
- **Play/Pause:** Spacebar toggles playback (when not in input field)
- **Auto-scroll:** Lyrics highlight and scroll during playback via `playerTimeUpdate` custom event

## Print Support

Print styles in `global.css` hide:
- YouTube player
- Navigation
- Admin links
- Timestamps

Trigger via browser print or the "Print Lyrics" button.

## Deployment

Vercel auto-deploys when you push to master:

```bash
git add -A
git commit -m "Your message"
git push origin master
```

Changes appear at lyric.bwe4.net within ~1 minute.

## Lyrics Sources (Priority Order)

1. **LRCLIB** (automatic) - Best source with timestamps
2. **jspinyin.net** (manual) - Chinese lyrics with pinyin
3. **Mojim.com** (manual) - Chinese lyrics without pinyin
4. **Manual entry** - Last resort via admin page

## Key Learnings

### Translation Filter Gotchas
- Don't use overly broad patterns like `/^I will/i`
- Test filter changes against all songs to avoid false positives
- Use `grep -n "pattern" data/songs.json` to check impact

### LRCLIB Quirks
- ~60% hit rate for Chinese songs; not all have synced (timestamped) lyrics
- **WhisperX on Tower** generates timestamps when LRCLIB doesn't have them (see Workflow 5)
- Search by artist + title in romanized form often works better
- Try Chinese artist names (鄧紫棋) if English names fail
- Always check LRCLIB after manual entry - songs get added over time

### Gemini Translation
- Sometimes produces noise like "I will check the translation..."
- Filter catches most cases, but manual review recommended
- Can fail to translate certain lines (outputs `[translation unavailable]`)

### jspinyin.net Extraction
- Best source for Chinese songs with pinyin
- Use Steel browser MCP for extraction (handles dynamic content)
- Format: Chinese line, then pinyin line, alternating

### Word Segmentation (Ruby Alignment)

**Best approach: Inline in Claude Code session.** Claude generates segments directly — no scripts, no session spawning.

**Why not scripts:**
- `add-segments-sonnet.ts` spawns a `claude -p` session per batch (~72 sessions for all songs). Can't run inside Claude Code due to CLAUDECODE env var blocking nested CLI calls.
- `add-segments-groq.ts` uses HTTP API (no spawning) but quality is terrible (char-by-char splits).
- Inline segmentation is higher quality and zero overhead for single-song additions.

**Model quality comparison:**

| Model | Quality | Notes |
|-------|---------|-------|
| **Claude (inline)** | ✅ Excellent | Proper word grouping, preserves idioms |
| Llama 70B (Groq) | ❌ Poor | Char-by-char (愛\|情 instead of 愛情) |
| GPT OSS 120B (Groq) | ❌ Unusable | JSON truncation issues (~60% fail) |
| Qwen 32B (Groq) | ⚠️ Inconsistent | Good then bad on same task |
| Gemini 3 Flash | ❌ Poor | "Agentic" thinking breaks JSON output |

**Key findings:**
- Chinese word segmentation requires linguistic understanding, not just speed
- Groq models are fast but produce character-by-character splits
- Gemini's "agentic" behavior outputs thinking text instead of JSON
- Claude properly groups: 愛情, 再見, 刻骨銘心 (idioms stay together)

**For batch re-segmentation** (all songs), the right fix would be a script using the Anthropic API directly (HTTP, not CLI) to avoid the CLAUDECODE nesting issue.

### Pinyin Font Rendering
Chinese fonts (Noto Sans SC) render Latin diacritics poorly - macrons (ō) shift right. Solution: use system fonts for pinyin.

```css
.ruby-pinyin {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
```

## Checking for Issues

**Primary:** `bun run validate` — runs all checks, see Workflow 6.

**Quick grep commands:**
```bash
grep '"hasLyrics": false' data/songs.json              # Songs without lyrics
grep -n "\[translation unavailable\]" data/songs.json   # Missing translations
```

## Files to Watch

| File | Purpose | When to Update |
|------|---------|----------------|
| `data/songs.json` | All lyrics data | Adding/editing lyrics |
| `src/components/LyricsDisplay.astro` | Display + filter | Fixing display issues |
| `scripts/build-data.ts` | LRCLIB fetching | Adding new songs to playlist |

## External APIs

| API | Purpose | Auth |
|-----|---------|------|
| LRCLIB | Synced lyrics | None |
| YouTube IFrame | Video playback | None |
| Gemini CLI | Translation | ~/.gemini (local) |

## Known Constraints

### CLAUDECODE Nesting
Scripts that spawn `claude -p` (like `add-segments-sonnet.ts`) cannot run inside a Claude Code session. The `CLAUDECODE` environment variable blocks nested CLI calls. Workarounds:
- **Preferred:** Do the work inline (Claude generates segments directly in session)
- **For automation:** Use the Anthropic HTTP API directly instead of the CLI

### LRCLIB Coverage for Chinese Music
LRCLIB has ~60% hit rate for Chinese songs. Of those found, not all have synced (timestamped) lyrics. Always check, but expect to need manual lyrics + WhisperX timestamps for many songs.

### WhisperX Alignment Quality
Timestamp alignment varies dramatically by song type:
- Clean vocals, ballads, worship: 85-90%
- Fast delivery, rap: 20-50%
- Songs with non-Chinese sections: Alignment breaks on those sections

### Script Session Spawning
Several scripts spawn dozens of headless CLI sessions via `Bun.spawn()` loops:
- `add-segments-sonnet.ts`: ~72 `claude -p` sessions (all songs)
- `build-data.ts`: ~19+ `gemini -p` sessions (translations)
- `add-segments.ts`: ~100+ `gemini` sessions

**Avoid running these scripts.** For single-song additions, all work (translation, segmentation) should be done inline in the Claude Code session. For batch operations, scripts should be rewritten to use HTTP APIs directly.

## Song Addition Pipeline (Recommended)

The end-to-end pipeline for adding a new song:

```
1. SYNC      → bun run sync (discovers new songs from YouTube Music playlist)
2. LYRICS    → LRCLIB (auto) → manual sources if needed → Claude generates pinyin/translation/segments inline
3. TIMESTAMPS → LRCLIB synced lyrics (best) → WhisperX on Tower + align-timestamps.py (fallback)
4. VALIDATE  → Check: translations, segments, timestamp coverage, bilingual detection
5. DEPLOY    → git push → Vercel auto-deploys
```

**Key principle:** Prefer inline work in Claude Code sessions over script automation. The scripts were built for batch processing but create problematic session spawning. For 1-5 songs at a time, inline is faster and higher quality.

---

*CLAUDE.md is the single source of truth for this project. No separate docs folder needed.*
