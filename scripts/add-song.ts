#!/usr/bin/env bun
/**
 * Add a new song to the lyrics library
 *
 * Usage:
 *   bun run add <youtube-id> "Song Title" "Artist Name"
 *   bun run add dI77xEZeDnI "Heaven.zip" "LÜCY"
 *
 * Or interactive mode:
 *   bun run add
 */

import { readFile, writeFile } from 'fs/promises';
import { pinyin } from 'pinyin-pro';

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

async function loadSongs(): Promise<Song[]> {
  const data = await readFile(SONGS_PATH, 'utf-8');
  return JSON.parse(data);
}

async function saveSongs(songs: Song[]): Promise<void> {
  await writeFile(SONGS_PATH, JSON.stringify(songs, null, 2));
}

async function fetchLRCLib(artist: string, track: string): Promise<{ synced?: string; plain?: string; album?: string; duration?: number } | null> {
  const variations = [
    { artist, title: track },
    { artist: artist.split(' ')[0], title: track },
  ];

  for (const { artist: a, title: t } of variations) {
    const params = new URLSearchParams({ artist_name: a, track_name: t });

    try {
      // Try exact match
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

      // Try search
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

  console.log(`  Generating pinyin for ${rawLines.length} lines...`);
  const pinyinLines = rawLines.map(l => toPinyin(l.text));

  console.log(`  Translating with Gemini...`);
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

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  const n = await Bun.stdin.read(buf);
  return buf.slice(0, n!).toString().trim();
}

async function main() {
  const args = process.argv.slice(2);

  let videoId: string;
  let title: string;
  let artist: string;

  if (args.length >= 3) {
    [videoId, title, artist] = args;
  } else if (args.length === 1) {
    videoId = args[0];
    title = await prompt('Song title: ');
    artist = await prompt('Artist: ');
  } else {
    console.log('Usage: bun run add <youtube-id> "Song Title" "Artist"');
    console.log('   or: bun run add <youtube-id>  (interactive mode)');
    console.log('   or: bun run add               (fully interactive)');
    console.log('\nExample:');
    console.log('  bun run add dI77xEZeDnI "Heaven.zip" "LÜCY"');
    process.exit(1);
  }

  // Load existing songs
  const songs = await loadSongs();

  // Check if already exists
  if (songs.find(s => s.id === videoId)) {
    console.log(`\n⚠️  Song already exists: ${videoId}`);
    const existing = songs.find(s => s.id === videoId)!;
    console.log(`   ${existing.artist} - ${existing.title}`);
    console.log(`   Has lyrics: ${existing.hasLyrics}`);
    process.exit(0);
  }

  console.log(`\nAdding: ${artist} - ${title}`);
  console.log(`YouTube ID: ${videoId}`);
  console.log(`https://youtube.com/watch?v=${videoId}\n`);

  const song: Song = {
    id: videoId,
    title,
    artist,
    hasLyrics: false,
  };

  // Try LRCLIB
  console.log('Checking LRCLIB...');
  const lrcData = await fetchLRCLib(artist, title);

  if (lrcData && (lrcData.synced || lrcData.plain)) {
    console.log('✓ Found lyrics on LRCLIB!');

    try {
      const lyrics = await processLyrics(lrcData);
      if (lyrics.length > 0) {
        song.hasLyrics = true;
        song.lyricsSource = 'lrclib';
        song.lyrics = lyrics;
        if (lrcData.album) song.album = lrcData.album;
        if (lrcData.duration) song.duration = lrcData.duration;
        console.log(`✓ Processed ${lyrics.length} lines with pinyin and translations`);
      }
    } catch (e) {
      console.log(`⚠️  Error processing: ${e}`);
    }
  } else {
    console.log('✗ Not found on LRCLIB');
    console.log('\nTo add lyrics manually:');
    console.log(`  1. Find lyrics at https://jspinyin.net (search for "${title}")"`);
    console.log(`  2. Use the admin page: https://lyric.bwe4.net/admin/${videoId}`);
    console.log('  3. Or edit data/songs.json directly');
  }

  // Add to songs array
  songs.push(song);

  // Save
  await saveSongs(songs);
  console.log('\n✓ Added to data/songs.json');

  if (song.hasLyrics) {
    console.log('\nNext steps:');
    console.log('  bun run build     # Build the site');
    console.log('  git add -A && git commit -m "Add ' + title + '" && git push');
  } else {
    console.log('\nSong added without lyrics. Add them via:');
    console.log(`  https://lyric.bwe4.net/admin/${videoId}`);
  }
}

main().catch(console.error);
