# Lyric

Chinese lyrics study tool that generates markdown files with:
- Original Chinese lyrics
- Pinyin romanization
- English translation

Perfect for learning Chinese through music.

## Features

- **Playlist processing**: Process entire YouTube/YouTube Music playlists
- **Lyrics from LRCLIB**: Free, community-maintained lyrics database
- **Pinyin conversion**: Using pinyin-pro with tone marks (ā á ǎ à)
- **Translation**: Via Gemini CLI (free)
- **Synced lyrics**: Preserves timestamps when available

## Installation

```bash
# Clone the repo
git clone https://github.com/bulgogi777/lyric.git
cd lyric

# Install dependencies
bun install

# Ensure yt-dlp is available (for playlist extraction)
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /tmp/yt-dlp
chmod +x /tmp/yt-dlp
```

## Requirements

- [Bun](https://bun.sh) runtime
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) for translation
- yt-dlp for playlist extraction

## Usage

### Process a playlist

```bash
bun run src/cli.ts playlist "https://music.youtube.com/playlist?list=PLO52moo..." --output ./songs
```

### Process a single song

```bash
bun run src/cli.ts song "Eric Chou" "What's Wrong"
```

### Test the tool

```bash
bun run test
```

## Output Format

Each song generates a markdown file like:

```markdown
# What's Wrong

**Artist:** Eric Chou
**Album:** Freedom
**Duration:** 5:21
**YouTube:** https://www.youtube.com/watch?v=KFxO-Mj3q0c

---

*[00:15.00]*
**你說藍色是你最愛的顏色**
*nǐ shuō lán sè shì nǐ zuì ài de yán sè*
You said blue is your favorite color

*[00:19.50]*
**你說如果沒有愛那又如何**
*nǐ shuō rú guǒ méi yǒu ài nà yòu rú hé*
You said so what if there is no love
```

## Data Sources

- **Lyrics**: [LRCLIB](https://lrclib.net) - Free, no API key required
- **Translation**: Gemini CLI - Free tier
- **Playlist data**: yt-dlp - Free, open source

## License

MIT
