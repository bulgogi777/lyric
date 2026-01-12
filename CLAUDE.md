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
│   └── build-data.ts             # LRCLIB fetch + Gemini translation
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

### 2. Adding Lyrics Manually (via jspinyin.net)

For songs not in LRCLIB:

1. **Find lyrics** on https://jspinyin.net (search for song title)
2. **Extract** Chinese characters and pinyin from the page
3. **Translate** Chinese to English (Claude can do this)
4. **Update songs.json** with the lyrics array
5. **Build and push:**
   ```bash
   bun run build
   git add -A && git commit -m "Add lyrics for [song]" && git push
   ```

### 3. Using the Admin Editor

1. Navigate to `/admin/[youtube-id]`
2. Edit lyrics directly in the UI
3. Click "Copy JSON" to get the lyrics array
4. Paste into `data/songs.json` and rebuild

### 4. Fixing Translation Issues

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
- Some songs have timestamps, some don't
- Search by artist + title in romanized form often works better

### Gemini Translation
- Sometimes produces noise like "I will check the translation..."
- Filter catches most cases, but manual review recommended
- Can fail to translate certain lines (outputs `[translation unavailable]`)

### jspinyin.net Extraction
- Best source for Chinese songs with pinyin
- Use Steel browser MCP for extraction (handles dynamic content)
- Format: Chinese line, then pinyin line, alternating

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
