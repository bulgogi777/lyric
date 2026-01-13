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
│   ├── add-segments-sonnet.ts    # Word segmentation via Claude Sonnet
│   └── add-segments-groq.ts      # Word segmentation via Groq (fast/lower quality)
└── .dev/specs/
    └── lyric-web-app.md          # Full PRD and task breakdown
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
2. **Provide to Claude** - Claude will:
   - Add pinyin romanization (using pinyin-pro patterns)
   - Translate to English
   - **Generate word segments** for ruby alignment (see below)
   - Format as JSON for songs.json
3. **Check LRCLIB for timestamps** (song may have been added since):
   ```bash
   curl -s "https://lrclib.net/api/search?artist_name=ARTIST&track_name=TITLE" | jq '.[0].syncedLyrics'
   ```
4. **If timestamps exist**, merge them with Claude's translations
5. **Build and push:**
   ```bash
   bun run build
   git add -A && git commit -m "Add lyrics for [song]" && git push
   ```

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

**Note:** Manual entry will NOT have timestamps unless LRCLIB has them. Timestamps enable lyric sync with video playback.

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

### 5. Generating Timestamps via Whisper (When LRCLIB Unavailable)

When LRCLIB doesn't have timestamps for a song, use Whisper ASR to generate them:

**Prerequisites:**
- Whisper ASR service running on Tower (`http://tower:9000/asr`)
- yt-dlp installed on Tower (`~/.local/bin/yt-dlp`)

**Process:**

1. **Download audio on Tower** (YouTube blocks datacenter IPs, Tower has residential):
   ```bash
   ssh tower "~/.local/bin/yt-dlp -x -o '/tmp/VIDEOID.%(ext)s' 'https://youtube.com/watch?v=VIDEOID'"
   ```

2. **Transcribe with Whisper** (Chinese language, SRT output):
   ```bash
   ssh tower "curl -s -X POST 'http://localhost:9000/asr?language=zh&output=srt' \
     -F 'audio_file=@/tmp/VIDEOID.webm'" > .dev/srt-timestamps/VIDEOID.srt
   ```

3. **Manual alignment** - Compare SRT timestamps to existing lyrics:
   - SRT format: `00:00:13,600 --> 00:00:15,800` (start --> end)
   - Our format: `00:13.60` (just start time, MM:SS.ss)
   - Match Whisper's Chinese (imperfect) to our lyrics and grab timestamps
   - Update `data/songs.json` with aligned timestamps

4. **Clean up Tower:**
   ```bash
   ssh tower "rm /tmp/VIDEOID.webm"
   ```

**Batch processing (multiple songs):**
```bash
# Download all
ssh tower 'for id in ID1 ID2 ID3; do
  ~/.local/bin/yt-dlp -x -o "/tmp/lyrics/${id}.%(ext)s" "https://youtube.com/watch?v=${id}"
done'

# Transcribe all
ssh tower 'for f in /tmp/lyrics/*.webm; do
  id=$(basename "$f" .webm)
  curl -s -X POST "http://localhost:9000/asr?language=zh&output=srt" -F "audio_file=@${f}" > "/tmp/lyrics/${id}.srt"
done'

# Copy locally and clean up
scp tower:/tmp/lyrics/*.srt .dev/srt-timestamps/
ssh tower "rm -rf /tmp/lyrics"
```

**SRT files location:** `.dev/srt-timestamps/` (gitignored, temporary working files)

**Note:** Whisper transcription won't be perfect, but timestamps are usually accurate. Manual review is required to match Whisper segments to your lyric lines.

### 6. Fixing Translation Issues

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
- Not all Chinese songs are available
- LRCLIB is the preferred source for timestamps, but **Whisper ASR can generate them** (see workflow 5)
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

**Best Model: Claude Sonnet** - Use for all Chinese word segmentation tasks.

| Model | Quality | Notes |
|-------|---------|-------|
| **Claude Sonnet** | ✅ Excellent | Proper word grouping, preserves idioms |
| Llama 70B (Groq) | ❌ Poor | Char-by-char (愛\|情 instead of 愛情) |
| GPT OSS 120B (Groq) | ❌ Unusable | JSON truncation issues (~60% fail) |
| Qwen 32B (Groq) | ⚠️ Inconsistent | Good then bad on same task |
| Gemini 3 Flash | ❌ Poor | "Agentic" thinking breaks JSON output |

**Key findings:**
- Chinese word segmentation requires linguistic understanding, not just speed
- Groq models are fast but produce character-by-character splits
- Gemini's "agentic" behavior outputs thinking text instead of JSON
- Sonnet properly groups: 愛情, 再見, 刻骨銘心 (idioms stay together)

**Segmentation scripts:**
```bash
bun run scripts/add-segments-sonnet.ts  # Best quality (recommended)
bun run scripts/add-segments-groq.ts    # Fast but poor quality
```

### Pinyin Font Rendering
Chinese fonts (Noto Sans SC) render Latin diacritics poorly - macrons (ō) shift right. Solution: use system fonts for pinyin.

```css
.ruby-pinyin {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
```

## Checking for Issues

```bash
# Find songs without lyrics
grep '"hasLyrics": false' data/songs.json

# Find placeholder translations
grep -n "\[translation unavailable\]" data/songs.json

# Find potential LLM noise in translations
grep -E "I will|I'll check|directory" data/songs.json
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

---

*See `.dev/specs/lyric-web-app.md` for full PRD and task breakdown.*
