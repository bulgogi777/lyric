#!/usr/bin/env bun
/**
 * Sync songs from YouTube Music playlist
 *
 * Usage:
 *   bun run sync          # Check for new songs
 *   bun run sync --add    # Add new songs and fetch lyrics
 */

import { readFile, writeFile } from 'fs/promises';
import { pinyin } from 'pinyin-pro';

const PLAYLIST_URL = 'https://music.youtube.com/playlist?list=PLO52moohuiUEEkKEwOSWoSd8S6rNc0mOv';
const SONGS_PATH = '/home/debian/apex/x/code/lyric/data/songs.json';

interface LyricLine {
  timestamp?: string;
  chinese: string;
  pinyin: string;
  english: string;
}

interface Song {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  hasLyrics: boolean;
  lyricsSource?: 'lrclib' | 'manual' | 'jspinyin';
  lyrics?: LyricLine[];
}

interface PlaylistEntry {
  id: string;
  title: string;
  channel: string;
}

async function loadSongs(): Promise<Song[]> {
  const data = await readFile(SONGS_PATH, 'utf-8');
  return JSON.parse(data);
}

async function saveSongs(songs: Song[]): Promise<void> {
  await writeFile(SONGS_PATH, JSON.stringify(songs, null, 2));
}

async function fetchPlaylist(): Promise<PlaylistEntry[]> {
  console.log('Fetching playlist from YouTube Music...');

  const proc = Bun.spawn([
    'ssh', 'tower',
    '/root/.local/bin/yt-dlp',
    '--flat-playlist',
    '-J',
    PLAYLIST_URL,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`yt-dlp failed: ${stderr}`);
  }

  const data = JSON.parse(output);
  return data.entries.map((e: any) => ({
    id: e.id,
    title: e.title,
    // Clean up artist name (remove " - Topic", " Official", etc.)
    channel: e.channel
      ?.replace(/ - Topic$/, '')
      .replace(/ Official$/, '')
      .replace(/ VEVO$/, '')
      .trim() || 'Unknown Artist',
  }));
}

async function fetchLRCLib(artist: string, track: string): Promise<{ synced?: string; plain?: string; album?: string; duration?: number } | null> {
  const variations = [
    { artist, title: track },
    { artist: artist.split(' ')[0], title: track },
  ];

  for (const { artist: a, title: t } of variations) {
    const params = new URLSearchParams({ artist_name: a, track_name: t });

    try {
      let response = await fetch(`https://lrclib.net/api/get?${params}`);
      if (response.ok) {
        const data = await response.json();
        if (data.syncedLyrics || data.plainLyrics) {
          return {
            synced: data.syncedLyrics,
            plain: data.plainLyrics,
            album: data.albumName,
            duration: data.duration,
          };
        }
      }

      response = await fetch(`https://lrclib.net/api/search?${params}`);
      if (response.ok) {
        const results = await response.json();
        if (Array.isArray(results) && results.length > 0) {
          return {
            synced: results[0].syncedLyrics,
            plain: results[0].plainLyrics,
            album: results[0].albumName,
            duration: results[0].duration,
          };
        }
      }
    } catch (e) {
      // Continue to next variation
    }
  }

  return null;
}

function parseLRC(lrc: string): Array<{ timestamp: string; text: string }> {
  const lines: Array<{ timestamp: string; text: string }> = [];
  const regex = /\[(\d{2}:\d{2}\.\d{2,3})\](.*)/g;

  let match;
  while ((match = regex.exec(lrc)) !== null) {
    const text = match[2].trim();
    if (text) {
      lines.push({ timestamp: match[1], text });
    }
  }

  return lines;
}

function toPinyin(text: string): string {
  return pinyin(text, {
    toneType: 'symbol',
    type: 'string',
    separator: ' ',
  });
}

function isLLMNoise(text: string): boolean {
  const noisePatterns = [
    /^I will/i, /^I'll/i, /^I need to/i, /^Let me/i,
    /\.md`/, /`[^`]+`/, /directory/i, /file/i,
    /check.*translation/i, /read.*to understand/i,
  ];
  return noisePatterns.some(p => p.test(text));
}

async function translateWithGemini(chineseLines: string[]): Promise<string[]> {
  if (chineseLines.length === 0) return [];

  const prompt = `TASK: Translate Chinese song lyrics to English.

RULES:
- Output EXACTLY ${chineseLines.length} lines
- One English translation per line
- No numbering, no explanations, no thinking
- Just the translations, nothing else

LYRICS:
${chineseLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}

TRANSLATIONS:`;

  const proc = Bun.spawn(['gemini', '-p', prompt], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error('Gemini translation failed');
  }

  const translations = output
    .trim()
    .split('\n')
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(line => line.length > 0 && !isLLMNoise(line));

  while (translations.length < chineseLines.length) {
    translations.push('[translation unavailable]');
  }

  return translations.slice(0, chineseLines.length);
}

async function processLyrics(lrcData: { synced?: string; plain?: string }): Promise<LyricLine[]> {
  let rawLines: Array<{ text: string; timestamp?: string }>;

  if (lrcData.synced) {
    rawLines = parseLRC(lrcData.synced).map(l => ({ text: l.text, timestamp: l.timestamp }));
  } else if (lrcData.plain) {
    rawLines = lrcData.plain
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(text => ({ text }));
  } else {
    return [];
  }

  console.log(`    Generating pinyin for ${rawLines.length} lines...`);
  const pinyinLines = rawLines.map(l => toPinyin(l.text));

  console.log(`    Translating with Gemini...`);
  const chineseTexts = rawLines.map(l => l.text);
  const BATCH_SIZE = 20;
  const translations: string[] = [];

  for (let i = 0; i < chineseTexts.length; i += BATCH_SIZE) {
    const batch = chineseTexts.slice(i, i + BATCH_SIZE);
    const batchTranslations = await translateWithGemini(batch);
    translations.push(...batchTranslations);
  }

  return rawLines.map((raw, i) => ({
    chinese: raw.text,
    pinyin: pinyinLines[i],
    english: translations[i] || '[translation unavailable]',
    timestamp: raw.timestamp,
  }));
}

async function addSong(entry: PlaylistEntry): Promise<Song> {
  console.log(`\n  Processing: ${entry.channel} - ${entry.title}`);

  const song: Song = {
    id: entry.id,
    title: entry.title,
    artist: entry.channel,
    hasLyrics: false,
  };

  // Try LRCLIB
  console.log('    Checking LRCLIB...');
  const lrcData = await fetchLRCLib(entry.channel, entry.title);

  if (lrcData && (lrcData.synced || lrcData.plain)) {
    console.log('    ✓ Found lyrics!');

    try {
      const lyrics = await processLyrics(lrcData);
      if (lyrics.length > 0) {
        song.hasLyrics = true;
        song.lyricsSource = 'lrclib';
        song.lyrics = lyrics;
        if (lrcData.album) song.album = lrcData.album;
        if (lrcData.duration) song.duration = lrcData.duration;
        console.log(`    ✓ Processed ${lyrics.length} lines`);
      }
    } catch (e) {
      console.log(`    ⚠️  Error processing: ${e}`);
    }
  } else {
    console.log('    ✗ No lyrics on LRCLIB (will need manual entry)');
  }

  return song;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldAdd = args.includes('--add') || args.includes('-a');

  // Fetch current playlist
  const playlistEntries = await fetchPlaylist();
  console.log(`Found ${playlistEntries.length} songs in playlist\n`);

  // Load existing songs
  const existingSongs = await loadSongs();
  const existingIds = new Set(existingSongs.map(s => s.id));

  // Find new songs
  const newEntries = playlistEntries.filter(e => !existingIds.has(e.id));

  // Also find removed songs (in data but not in playlist)
  const playlistIds = new Set(playlistEntries.map(e => e.id));
  const removedSongs = existingSongs.filter(s => !playlistIds.has(s.id));

  // Status report
  console.log('='.repeat(50));
  console.log(`Existing songs: ${existingSongs.length}`);
  console.log(`Playlist songs: ${playlistEntries.length}`);
  console.log(`New songs:      ${newEntries.length}`);
  if (removedSongs.length > 0) {
    console.log(`Removed:        ${removedSongs.length}`);
  }
  console.log('='.repeat(50));

  if (newEntries.length === 0) {
    console.log('\n✓ All songs are synced!');
    return;
  }

  console.log('\nNew songs to add:');
  newEntries.forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.channel} - ${e.title}`);
    console.log(`     https://youtube.com/watch?v=${e.id}`);
  });

  if (!shouldAdd) {
    console.log('\nRun with --add to fetch lyrics and add these songs:');
    console.log('  bun run sync --add');
    return;
  }

  // Add new songs
  console.log('\nAdding new songs...');
  const newSongs: Song[] = [];

  for (const entry of newEntries) {
    const song = await addSong(entry);
    newSongs.push(song);
  }

  // Merge and save
  const allSongs = [...existingSongs, ...newSongs];
  await saveSongs(allSongs);

  // Summary
  const withLyrics = newSongs.filter(s => s.hasLyrics);
  const withoutLyrics = newSongs.filter(s => !s.hasLyrics);

  console.log('\n' + '='.repeat(50));
  console.log('Summary:');
  console.log(`  Added: ${newSongs.length} songs`);
  console.log(`  With lyrics: ${withLyrics.length}`);
  console.log(`  Without lyrics: ${withoutLyrics.length}`);

  if (withoutLyrics.length > 0) {
    console.log('\nSongs needing manual lyrics:');
    withoutLyrics.forEach(s => {
      console.log(`  - ${s.artist} - ${s.title}`);
      console.log(`    https://lyric.bwe4.net/admin/${s.id}`);
    });
  }

  console.log('\nNext steps:');
  console.log('  bun run build');
  console.log('  git add -A && git commit -m "Add new songs" && git push');
}

main().catch(console.error);
