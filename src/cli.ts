#!/usr/bin/env bun
/**
 * Lyric - Chinese lyrics study tool
 *
 * Usage:
 *   lyric playlist <url> [--output <dir>]   Process all songs in a playlist
 *   lyric song <artist> <title>             Process a single song
 *   lyric test                              Test with a known song
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPlaylist, cleanArtistName, parseTrackTitle } from './playlist';
import { processSong, formatMarkdown, fetchLyrics, toPinyin } from './lyrics';

async function processPlaylist(playlistUrl: string, outputDir: string) {
  console.log('Extracting playlist...');
  const playlist = await extractPlaylist(playlistUrl);

  console.log(`\nPlaylist: ${playlist.title}`);
  console.log(`Tracks: ${playlist.tracks.length}\n`);

  // Create output directory
  const playlistDir = join(outputDir, sanitizeFilename(playlist.title));
  await mkdir(playlistDir, { recursive: true });

  // Process each track
  const results: Array<{ track: string; status: 'success' | 'no-lyrics' | 'error'; file?: string }> = [];

  for (let i = 0; i < playlist.tracks.length; i++) {
    const track = playlist.tracks[i];
    const cleanArtist = cleanArtistName(track.artist);
    const { title: cleanTitle } = parseTrackTitle(track.title);

    console.log(`\n[${i + 1}/${playlist.tracks.length}] ${cleanArtist} - ${cleanTitle}`);

    try {
      const processed = await processSong({
        videoId: track.videoId,
        title: cleanTitle,
        artist: cleanArtist,
      });

      if (processed) {
        const markdown = formatMarkdown(processed);
        const filename = `${sanitizeFilename(cleanArtist)} - ${sanitizeFilename(cleanTitle)}.md`;
        const filepath = join(playlistDir, filename);

        await Bun.write(filepath, markdown);
        console.log(`  ✓ Saved to ${filename}`);
        results.push({ track: `${cleanArtist} - ${cleanTitle}`, status: 'success', file: filename });
      } else {
        console.log(`  ✗ No lyrics found`);
        results.push({ track: `${cleanArtist} - ${cleanTitle}`, status: 'no-lyrics' });
      }
    } catch (error) {
      console.error(`  ✗ Error: ${error}`);
      results.push({ track: `${cleanArtist} - ${cleanTitle}`, status: 'error' });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const success = results.filter(r => r.status === 'success').length;
  const noLyrics = results.filter(r => r.status === 'no-lyrics').length;
  const errors = results.filter(r => r.status === 'error').length;

  console.log(`✓ Success: ${success}`);
  console.log(`✗ No lyrics: ${noLyrics}`);
  console.log(`! Errors: ${errors}`);
  console.log(`\nOutput directory: ${playlistDir}`);

  // Write index file
  const indexMd = generatePlaylistIndex(playlist.title, results);
  await Bun.write(join(playlistDir, '_index.md'), indexMd);
  console.log(`Index saved to: ${playlistDir}/_index.md`);
}

async function processSingleSong(artist: string, title: string, outputDir: string) {
  console.log(`Processing: ${artist} - ${title}`);

  const processed = await processSong({
    videoId: '',
    title,
    artist,
  });

  if (!processed) {
    console.log('No lyrics found');
    process.exit(1);
  }

  const markdown = formatMarkdown(processed);
  const filename = `${sanitizeFilename(artist)} - ${sanitizeFilename(title)}.md`;
  const filepath = join(outputDir, filename);

  await mkdir(outputDir, { recursive: true });
  await Bun.write(filepath, markdown);
  console.log(`Saved to: ${filepath}`);
}

async function testSong() {
  console.log('Testing with: Eric Chou - What\'s Wrong\n');

  // Test lyrics fetch
  console.log('1. Fetching lyrics from LRCLIB...');
  const lyrics = await fetchLyrics('Eric Chou', "What's Wrong");
  if (!lyrics) {
    console.log('   ✗ No lyrics found');
    return;
  }
  console.log(`   ✓ Found lyrics (${lyrics.plainLyrics?.split('\n').length || 0} lines)`);

  // Test pinyin
  console.log('\n2. Testing pinyin conversion...');
  const sample = '你說藍色是你最愛的顏色';
  const pinyinResult = toPinyin(sample);
  console.log(`   Input:  ${sample}`);
  console.log(`   Pinyin: ${pinyinResult}`);

  // Test full processing
  console.log('\n3. Full processing test...');
  const processed = await processSong({
    videoId: 'KFxO-Mj3q0c',
    title: "What's Wrong",
    artist: 'Eric Chou',
  });

  if (processed) {
    console.log(`   ✓ Processed ${processed.lines.length} lines`);
    console.log('\nSample output (first 3 lines):');
    for (const line of processed.lines.slice(0, 3)) {
      console.log(`   ${line.chinese}`);
      console.log(`   ${line.pinyin}`);
      console.log(`   ${line.english}`);
      console.log();
    }
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function generatePlaylistIndex(title: string, results: Array<{ track: string; status: string; file?: string }>): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `*Generated: ${new Date().toISOString().split('T')[0]}*`,
    '',
    '## Songs',
    '',
  ];

  for (const result of results) {
    if (result.status === 'success' && result.file) {
      lines.push(`- [${result.track}](${encodeURIComponent(result.file)})`);
    } else {
      lines.push(`- ${result.track} *(${result.status})*`);
    }
  }

  return lines.join('\n');
}

// CLI entry point
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'playlist': {
    const url = args[1];
    if (!url) {
      console.error('Usage: lyric playlist <url> [--output <dir>]');
      process.exit(1);
    }
    const outputIdx = args.indexOf('--output');
    const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : './output';
    await processPlaylist(url, outputDir);
    break;
  }

  case 'song': {
    const artist = args[1];
    const title = args[2];
    if (!artist || !title) {
      console.error('Usage: lyric song <artist> <title>');
      process.exit(1);
    }
    const outputIdx = args.indexOf('--output');
    const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : './output';
    await processSingleSong(artist, title, outputDir);
    break;
  }

  case 'test':
    await testSong();
    break;

  default:
    console.log(`Lyric - Chinese lyrics study tool

Usage:
  lyric playlist <url> [--output <dir>]   Process all songs in a playlist
  lyric song <artist> <title>             Process a single song
  lyric test                              Test with a known song

Examples:
  lyric playlist "https://music.youtube.com/playlist?list=PLO52moo..."
  lyric song "Eric Chou" "What's Wrong"
  lyric test
`);
}
