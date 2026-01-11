#!/usr/bin/env bun
/**
 * Build data/songs.json from:
 * 1. LRCLIB API for lyrics
 * 2. Gemini CLI for pinyin/translation
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { pinyin } from 'pinyin-pro';

// NEW Playlist from YouTube Music (extracted via yt-dlp)
const PLAYLIST = [
  { id: 'vWIOwhZLheY', title: '致姗姗来迟的你', artist: '阿肆' },
  { id: '3RAJlmB7iA0', title: '我當你空氣', artist: '旺福' },
  { id: 'dI77xEZeDnI', title: 'Heaven.zip', artist: 'LÜCY' },
  { id: 'KFxO-Mj3q0c', title: "What's Wrong", artist: '周興哲', altTitle: '怎麼了' },
  { id: 't3CrQQeM2EU', title: 'CHANGE', artist: '瘦子E.SO' },
  { id: '762rm2HAOGY', title: 'How Have You Been?', artist: '周興哲', altTitle: '你,好不好' },
  { id: 'x3xdtL-dnQo', title: "Something I Don't Need", artist: '瘦子E.SO' },
  { id: '-rylspVd3s8', title: "Don't Worry About Me", artist: '瘦子E.SO' },
  { id: 'GfcbOdIFWPE', title: '太陽', artist: '瘦子E.SO' },
  { id: 'VMC6ZQEysl8', title: '她沒在看我', artist: '瘦子E.SO' },
  { id: 'gRwFcnRMCtI', title: '我多喜歡你,你會知道', artist: '王俊琪' },
  { id: 'wiv6PpHJNSw', title: "It's a Long Day", artist: 'Joyce Chu 四葉草' },
  { id: 'YD9r_tTtlaA', title: '小幸運', artist: '田馥甄' },
];

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
  lyricsSource?: 'lrclib' | 'manual';
  lyrics?: LyricLine[];
}

const ROOT = '/home/debian/apex/x/code/lyric';
const DATA_DIR = join(ROOT, 'data');

/**
 * Fetch lyrics from LRCLIB API
 */
async function fetchLRCLib(artist: string, track: string): Promise<{ synced?: string; plain?: string; album?: string; duration?: number } | null> {
  const params = new URLSearchParams({
    artist_name: artist,
    track_name: track,
  });

  try {
    // Try exact match first
    let response = await fetch(`https://lrclib.net/api/get?${params}`);
    if (!response.ok) {
      // Try search as fallback
      response = await fetch(`https://lrclib.net/api/search?${params}`);
      if (!response.ok) return null;
      const results = await response.json();
      if (!Array.isArray(results) || results.length === 0) return null;
      return {
        synced: results[0].syncedLyrics,
        plain: results[0].plainLyrics,
        album: results[0].albumName,
        duration: results[0].duration,
      };
    }
    const data = await response.json();
    return {
      synced: data.syncedLyrics,
      plain: data.plainLyrics,
      album: data.albumName,
      duration: data.duration,
    };
  } catch (error) {
    console.error(`  LRCLIB error: ${error}`);
    return null;
  }
}

/**
 * Parse LRC format to lines with timestamps
 */
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

/**
 * Generate pinyin for Chinese text
 */
function toPinyin(text: string): string {
  return pinyin(text, {
    toneType: 'symbol',
    type: 'string',
    separator: ' ',
  });
}

/**
 * Translate Chinese lyrics using Gemini CLI
 */
async function translateWithGemini(chineseLines: string[]): Promise<string[]> {
  if (chineseLines.length === 0) return [];

  const prompt = `Translate these Chinese song lyrics to natural English. Return ONLY the translations, one per line, in the same order. No numbering, no explanations, no quotes.

${chineseLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;

  const proc = Bun.spawn(['gemini', '-p', prompt], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Gemini translation failed: ${stderr}`);
  }

  // Parse output - one translation per line
  const translations = output
    .trim()
    .split('\n')
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(line => line.length > 0);

  // Pad with placeholders if needed
  while (translations.length < chineseLines.length) {
    translations.push('[translation unavailable]');
  }

  return translations;
}

/**
 * Process LRCLIB lyrics: add pinyin and translate
 */
async function processLRCLibLyrics(lrcData: { synced?: string; plain?: string }): Promise<LyricLine[]> {
  let rawLines: Array<{ text: string; timestamp?: string }>;

  if (lrcData.synced) {
    rawLines = parseLRC(lrcData.synced).map(l => ({
      text: l.text,
      timestamp: l.timestamp,
    }));
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

  // Translate in batches
  console.log(`    Translating with Gemini...`);
  const chineseTexts = rawLines.map(l => l.text);
  const BATCH_SIZE = 20;
  const translations: string[] = [];

  for (let i = 0; i < chineseTexts.length; i += BATCH_SIZE) {
    const batch = chineseTexts.slice(i, i + BATCH_SIZE);
    console.log(`    Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chineseTexts.length / BATCH_SIZE)}`);
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

/**
 * Main build function
 */
async function main() {
  console.log('Building data/songs.json from LRCLIB...\n');

  await mkdir(DATA_DIR, { recursive: true });

  const songs: Song[] = [];

  for (const track of PLAYLIST) {
    console.log(`Processing: ${track.artist} - ${track.title}`);

    const song: Song = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      hasLyrics: false,
    };

    console.log(`  Fetching from LRCLIB...`);

    // Try different title/artist variations
    const searchVariations = [
      { artist: track.artist, title: track.title },
      { artist: track.artist, title: (track as any).altTitle },
      { artist: track.artist.split(' ')[0], title: track.title },
      { artist: track.artist.split(' ')[0], title: (track as any).altTitle },
    ].filter(v => v.title); // Only valid variations

    let lrcData = null;
    for (const { artist, title } of searchVariations) {
      console.log(`    Trying: ${artist} - ${title}`);
      lrcData = await fetchLRCLib(artist, title);
      if (lrcData && (lrcData.synced || lrcData.plain)) {
        console.log(`    Found lyrics!`);
        break;
      }
    }

    if (lrcData && (lrcData.synced || lrcData.plain)) {
      try {
        const lyrics = await processLRCLibLyrics(lrcData);
        if (lyrics.length > 0) {
          song.hasLyrics = true;
          song.lyricsSource = 'lrclib';
          song.lyrics = lyrics;
          if (lrcData.album) song.album = lrcData.album;
          if (lrcData.duration) song.duration = lrcData.duration;
          console.log(`  Processed ${lyrics.length} lines`);
        }
      } catch (error) {
        console.log(`  Error processing lyrics: ${error}`);
      }
    } else {
      console.log(`  No lyrics found - will need manual entry`);
    }

    songs.push(song);
    console.log('');
  }

  // Write songs.json
  const outputPath = join(DATA_DIR, 'songs.json');
  await writeFile(outputPath, JSON.stringify(songs, null, 2));

  // Summary
  const withLyrics = songs.filter(s => s.hasLyrics);
  const withTimestamps = songs.filter(s => s.lyrics?.some(l => l.timestamp));

  console.log('='.repeat(50));
  console.log('Summary:');
  console.log(`  Total songs: ${songs.length}`);
  console.log(`  With lyrics: ${withLyrics.length}`);
  console.log(`  With timestamps: ${withTimestamps.length}`);
  console.log(`  Missing lyrics: ${songs.length - withLyrics.length}`);
  console.log(`\nMissing lyrics for:`);
  songs.filter(s => !s.hasLyrics).forEach(s => console.log(`  - ${s.artist} - ${s.title}`));
  console.log(`\nOutput: ${outputPath}`);
}

main().catch(console.error);
