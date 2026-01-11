# Feature: Lyric Web App

## User Story
As a Chinese language learner, I want a web app that displays song lyrics with pinyin and English translations so that I can study Chinese through music I enjoy.

## Requirements

### Functional
- FR-001: System MUST display playlist mirroring YouTube Music playlist
- FR-002: System MUST show song cards with title, artist, and lyrics availability status
- FR-003: System MUST display lyrics in stacked format: Chinese → Pinyin → English
- FR-004: System MUST show timestamps in left gutter (when available from LRCLIB)
- FR-005: System MUST embed YouTube player for selected song
- FR-006: System MUST allow clicking timestamps to seek YouTube player
- FR-007: System MUST provide print-friendly view (CSS @media print)
- FR-008: System MUST allow manual lyrics entry for songs missing from LRCLIB
- FR-009: System MUST process pasted Chinese lyrics via Gemini CLI (cleanup + pinyin + translation)
- FR-010: System MUST allow editing of all three lyric layers after generation
- FR-011: System MUST persist lyrics data in JSON format

### Non-Functional
- NFR-001: Page load under 2 seconds on broadband
- NFR-002: Mobile-responsive design
- NFR-003: Print output must be clean and readable

## Data Sources

| Source | Purpose | Fallback |
|--------|---------|----------|
| YouTube Music Playlist | Song list, metadata, video IDs | yt-dlp extraction |
| LRCLIB API | Lyrics with timestamps | Manual entry |
| Gemini CLI | Cleanup, pinyin, translation | None (required) |

## Acceptance Scenarios

**Scenario 1: View Playlist**
- GIVEN user navigates to lyric.bwe4.net
- WHEN page loads
- THEN user sees playlist with all songs, indicating which have lyrics available

**Scenario 2: View Song with Lyrics**
- GIVEN a song has lyrics in the data store
- WHEN user clicks the song
- THEN lyrics display stacked (Chinese/Pinyin/English) with YouTube player

**Scenario 3: Seek via Timestamp**
- GIVEN a song is playing with synced lyrics
- WHEN user clicks a timestamp
- THEN YouTube player seeks to that position

**Scenario 4: Add Missing Lyrics**
- GIVEN a song shows "lyrics unavailable"
- WHEN user clicks "Add Lyrics" and pastes Chinese text
- THEN Gemini processes it, user reviews/edits, and saves

**Scenario 5: Print Lyrics**
- GIVEN user is viewing a song
- WHEN user prints the page (Ctrl+P)
- THEN clean formatted lyrics print without UI chrome

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    lyric.bwe4.net                           │
├─────────────────────────────────────────────────────────────┤
│  Static Site (Astro/Vite)                                   │
│  ├── /                  → Playlist view                     │
│  ├── /song/[id]         → Song view + player                │
│  └── /admin/[id]        → Add/edit lyrics                   │
├─────────────────────────────────────────────────────────────┤
│  API Routes (lightweight)                                   │
│  ├── POST /api/process  → Gemini CLI for lyrics processing  │
│  └── POST /api/save     → Save to JSON data store           │
├─────────────────────────────────────────────────────────────┤
│  Data                                                       │
│  └── data/songs.json    → All song data + lyrics            │
└─────────────────────────────────────────────────────────────┘
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
  lyricsSource?: 'lrclib' | 'manual';
  lyrics?: LyricLine[];
}

interface LyricLine {
  timestamp?: string;            // "MM:SS.ss" format
  chinese: string;
  pinyin: string;
  english: string;
}
```

## Gemini Processing Prompt

```
You are a Chinese lyrics processor. Clean up and format the following raw lyrics.

Instructions:
1. Remove any metadata like [Verse], [Chorus], [Intro], timestamps, or annotations
2. Keep only actual sung lyrics (Chinese characters)
3. Split into individual lines
4. For each line, provide:
   - chinese: the original Chinese text
   - pinyin: romanization with tone marks (ā á ǎ à)
   - english: natural English translation

Return valid JSON array:
[
  {"chinese": "...", "pinyin": "...", "english": "..."},
  ...
]

Raw lyrics to process:
{input}
```

## Dependencies
- Gemini CLI (installed, available as `gemini`)
- yt-dlp (installed at /tmp/yt-dlp)
- LRCLIB API (free, no auth)
- YouTube IFrame API (client-side)

## Constraints
- No server-side YouTube scraping (use yt-dlp for initial data, IFrame API for playback)
- Personal use only (no auth needed)
- Lyrics stored locally in JSON (not external DB)

## Out of Scope
- User accounts / authentication
- Multiple playlists (single playlist for now)
- Lyrics syncing/highlighting during playback (future enhancement)
- Automated scraping of copyrighted lyrics sites

## Success Criteria
- SC-001: All songs from playlist visible on homepage
- SC-002: At least 7 songs have working lyrics display (from LRCLIB)
- SC-003: Manual lyrics entry workflow functional for remaining songs
- SC-004: YouTube player syncs with timestamp clicks
- SC-005: Print output is clean and usable for study

## Open Questions
- None remaining (all clarified in conversation)

---
## Technical Plan
<!-- Generated by /dev plan if needed -->

---
## Tasks

### Phase 1: Data Setup
- [ ] Extract playlist metadata from new YouTube Music URL via yt-dlp (data/songs.json)
- [ ] Fetch lyrics from LRCLIB for all songs, store in songs.json
- [ ] Process LRCLIB lyrics with Gemini for pinyin/translation
- [ ] Migrate any usable data from existing songs/Chinese/*.md

### Phase 2: Project Setup
- [ ] Initialize Astro project in existing directory
- [ ] Configure Tailwind CSS with Chinese font support
- [ ] Create base layout with responsive design (src/layouts/Base.astro)
- [ ] Create print layout (src/layouts/Print.astro)
- [ ] Set up API routes structure

### Phase 3: Playlist View (FR-001, FR-002)
- [ ] [P] Test: Playlist page displays all songs from data
- [ ] FR-001: Create SongCard component (src/components/SongCard.astro)
- [ ] FR-002: Build index page with song grid (src/pages/index.astro)
- [ ] Add lyrics availability indicator to cards

### Phase 4: Song View (FR-003, FR-004, FR-005, FR-006)
- [ ] [P] Test: Song page displays lyrics in stacked format
- [ ] [P] Test: YouTube player embeds and plays
- [ ] [P] Test: Timestamp click seeks player
- [ ] FR-003: Create LyricsDisplay component (src/components/LyricsDisplay.astro)
- [ ] FR-004: Add timestamp gutter to lyrics display
- [ ] FR-005: Create YouTubePlayer component (src/components/YouTubePlayer.astro)
- [ ] FR-006: Wire timestamp clicks to player.seekTo()
- [ ] Build song page (src/pages/song/[id].astro)

### Phase 5: Admin/Edit View (FR-008, FR-009, FR-010, FR-011)
- [ ] [P] Test: Paste lyrics and process with Gemini
- [ ] [P] Test: Edit all three layers
- [ ] [P] Test: Save persists to JSON
- [ ] FR-009: Create Gemini processing API route (src/pages/api/process.ts)
- [ ] FR-011: Create save API route (src/pages/api/save.ts)
- [ ] FR-008: Create LyricsEditor component (src/components/LyricsEditor.tsx)
- [ ] FR-010: Add edit mode for all three lyric layers
- [ ] Build admin page (src/pages/admin/[id].astro)

### Phase 6: Print Support (FR-007)
- [ ] [P] Test: Print output is clean without UI chrome
- [ ] FR-007: Create print.css with @media print rules
- [ ] Add print button to song view
- [ ] Verify print layout on Chrome/Firefox

### Phase 7: Deployment
- [ ] Push to GitHub repo (bulgogi777/lyric)
- [ ] Connect Vercel to GitHub repo
- [ ] Configure custom domain lyric.bwe4.net in Vercel
- [ ] Verify auto-deploy on push
- [ ] Verify all success criteria (SC-001 through SC-005)

### Phase 8: Validation
- [ ] Validation: All acceptance scenarios pass
- [ ] Validation: Mobile responsive check
- [ ] Validation: Print output review
