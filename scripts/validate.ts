#!/usr/bin/env bun
/**
 * Validate song data quality in songs.json
 *
 * Usage:
 *   bun run validate              # Validate all songs
 *   bun run validate SONG_ID      # Validate specific song
 *   bun run validate --summary    # Summary only (no per-line details)
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

const ROOT = '/home/debian/apex/x/code/lyric';
const DATA_PATH = join(ROOT, 'data/songs.json');

// Thresholds
const MIN_LINE_GAP_S = 1.0;       // Lines closer than this = near-duplicate
const MAX_LINE_GAP_S = 20.0;      // Lines further apart than this = suspicious gap
const MAX_SONG_DURATION_S = 600;   // 10 min max sanity check

interface Segment { hanzi: string; pinyin: string; }
interface LyricLine {
  timestamp?: string;
  chinese: string;
  pinyin: string;
  english: string;
  segments?: Segment[];
}
interface Song {
  id: string;
  title: string;
  artist: string;
  duration?: number;
  hasLyrics: boolean;
  lyrics?: LyricLine[];
  [key: string]: any;
}

interface Issue {
  level: 'error' | 'warn';
  line?: number;
  check: string;
  detail: string;
}

const LLM_NOISE_PATTERNS = [
  /^I will check/i, /^I will read/i, /^I will need/i,
  /^I'll check/i, /^I'll read/i,
  /^I need to check/i, /^Let me check/i, /^Let me read/i,
  /\.md`/, /`[^`]+`/, /\bdirectory\b/i,
  /check.*translation/i, /read.*to understand/i,
  /existing translation/i,
  /\[translation unavailable\]/,
];

function parseTimestamp(ts: string): number {
  // "MM:SS.ss" -> seconds
  const match = ts.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return NaN;
  return parseInt(match[1]) * 60 + parseFloat(match[2]);
}

function isChinese(ch: string): boolean {
  const code = ch.codePointAt(0) || 0;
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

function hasNonChinese(text: string): boolean {
  for (const ch of text) {
    if (/[a-zA-Z]/.test(ch)) return true;
    // Thai
    const code = ch.codePointAt(0) || 0;
    if (code >= 0x0e00 && code <= 0x0e7f) return true;
    // Japanese kana
    if (code >= 0x3040 && code <= 0x30ff) return true;
  }
  return false;
}

function validateSong(song: Song): Issue[] {
  const issues: Issue[] = [];

  if (!song.hasLyrics || !song.lyrics || song.lyrics.length === 0) {
    issues.push({ level: 'warn', check: 'lyrics', detail: 'No lyrics data' });
    return issues;
  }

  const lyrics = song.lyrics;
  const maxDuration = song.duration || MAX_SONG_DURATION_S;

  // Track timestamp state
  let prevTimestamp: number | null = null;
  let prevTimestampLine: number | null = null;

  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    const chinese = line.chinese?.trim() || '';

    // Skip empty/separator lines
    if (!chinese) continue;

    // --- Missing fields ---
    if (!line.english || line.english === '[translation unavailable]') {
      issues.push({ level: 'error', line: i, check: 'translation', detail: `Missing translation: "${chinese.slice(0, 20)}"` });
    }

    if (!line.segments || line.segments.length === 0) {
      issues.push({ level: 'error', line: i, check: 'segments', detail: `Missing segments: "${chinese.slice(0, 20)}"` });
    }

    // --- Segment consistency ---
    if (line.segments && line.segments.length > 0) {
      const reconstructed = line.segments.map(s => s.hanzi).join('');
      // Normalize for comparison: curly→straight quotes, collapse/strip whitespace around punctuation
      const normalize = (s: string) => s
        .replace(/[\u201c\u201d\u2018\u2019]/g, m => m === '\u201c' || m === '\u201d' ? '"' : "'")
        .replace(/\s+/g, ' ')
        .replace(/\s+([)）\]}])/g, '$1')  // strip space before closing brackets
        .replace(/([(\[{（])\s+/g, '$1')   // strip space after opening brackets
        .trim();
      if (normalize(reconstructed) !== normalize(chinese)) {
        issues.push({
          level: 'error', line: i, check: 'segment-mismatch',
          detail: `Segments don't reconstruct: "${chinese.slice(0, 20)}" vs "${reconstructed.slice(0, 20)}"`,
        });
      }

      // Check for malformed segment keys
      for (const seg of line.segments) {
        if (!('hanzi' in seg) || !('pinyin' in seg)) {
          issues.push({ level: 'error', line: i, check: 'segment-keys', detail: `Malformed segment keys: ${JSON.stringify(seg).slice(0, 50)}` });
          break;
        }
      }
    }

    // --- LLM noise ---
    if (line.english) {
      for (const pattern of LLM_NOISE_PATTERNS) {
        if (pattern.test(line.english)) {
          issues.push({ level: 'error', line: i, check: 'llm-noise', detail: `LLM noise: "${line.english.slice(0, 40)}"` });
          break;
        }
      }
    }

    // --- Bilingual detection ---
    if (hasNonChinese(chinese)) {
      issues.push({ level: 'warn', line: i, check: 'bilingual', detail: `Non-Chinese content: "${chinese.slice(0, 30)}"` });
    }

    // --- Timestamp checks ---
    if (!line.timestamp) {
      issues.push({ level: 'warn', line: i, check: 'no-timestamp', detail: `Missing timestamp: "${chinese.slice(0, 20)}"` });
    } else {
      const ts = parseTimestamp(line.timestamp);

      if (isNaN(ts)) {
        issues.push({ level: 'error', line: i, check: 'timestamp-format', detail: `Invalid format: "${line.timestamp}"` });
      } else {
        // Exceeds duration
        if (ts > maxDuration) {
          issues.push({ level: 'error', line: i, check: 'timestamp-overflow', detail: `${line.timestamp} exceeds duration (${maxDuration}s)` });
        }

        // Near-duplicate with previous
        if (prevTimestamp !== null) {
          const gap = ts - prevTimestamp;

          if (gap < 0) {
            issues.push({
              level: 'error', line: i, check: 'timestamp-order',
              detail: `Out of order: ${line.timestamp} < line ${prevTimestampLine} (went backwards ${Math.abs(gap).toFixed(1)}s)`,
            });
          } else if (gap < MIN_LINE_GAP_S) {
            issues.push({
              level: 'warn', line: i, check: 'timestamp-duplicate',
              detail: `Near-duplicate: only ${gap.toFixed(2)}s after line ${prevTimestampLine} (${line.timestamp})`,
            });
          } else if (gap > MAX_LINE_GAP_S) {
            issues.push({
              level: 'warn', line: i, check: 'timestamp-gap',
              detail: `Large gap: ${gap.toFixed(1)}s since line ${prevTimestampLine} (${lyrics[prevTimestampLine!]?.timestamp} → ${line.timestamp})`,
            });
          }
        }

        prevTimestamp = ts;
        prevTimestampLine = i;
      }
    }
  }

  return issues;
}

function printReport(song: Song, issues: Issue[], summaryOnly: boolean) {
  const lyrics = song.lyrics || [];
  const totalLines = lyrics.filter(l => l.chinese?.trim()).length;
  const withTs = lyrics.filter(l => l.timestamp).length;
  const withSegs = lyrics.filter(l => l.segments && l.segments.length > 0).length;
  const withEng = lyrics.filter(l => l.english && l.english !== '[translation unavailable]').length;

  const errors = issues.filter(i => i.level === 'error');
  const warns = issues.filter(i => i.level === 'warn');

  const status = errors.length > 0 ? '❌' : warns.length > 0 ? '⚠️' : '✅';

  console.log(`\n${status} ${song.title} — ${song.artist} (${song.id})`);
  console.log(`   Lines: ${totalLines}  Timestamps: ${withTs}/${totalLines}  Segments: ${withSegs}/${totalLines}  Translations: ${withEng}/${totalLines}`);

  if (errors.length > 0 || warns.length > 0) {
    console.log(`   Issues: ${errors.length} errors, ${warns.length} warnings`);
  }

  if (!summaryOnly && issues.length > 0) {
    for (const issue of issues) {
      const prefix = issue.level === 'error' ? '  ✗' : '  △';
      const lineRef = issue.line !== undefined ? ` [${issue.line}]` : '';
      console.log(`${prefix}${lineRef} ${issue.check}: ${issue.detail}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const summaryOnly = args.includes('--summary');
  const songId = args.find(a => !a.startsWith('--'));

  const songs: Song[] = JSON.parse(await readFile(DATA_PATH, 'utf-8'));
  const toValidate = songId
    ? songs.filter(s => s.id === songId || s.title.includes(songId))
    : songs.filter(s => s.hasLyrics);

  if (toValidate.length === 0) {
    console.log(songId ? `No song found matching "${songId}"` : 'No songs with lyrics to validate');
    return;
  }

  console.log(`Validating ${toValidate.length} song(s)...`);

  let totalErrors = 0;
  let totalWarns = 0;
  const songResults: Array<{ song: Song; issues: Issue[] }> = [];

  for (const song of toValidate) {
    const issues = validateSong(song);
    songResults.push({ song, issues });
    totalErrors += issues.filter(i => i.level === 'error').length;
    totalWarns += issues.filter(i => i.level === 'warn').length;
  }

  // Sort: most issues first
  songResults.sort((a, b) => b.issues.length - a.issues.length);

  for (const { song, issues } of songResults) {
    printReport(song, issues, summaryOnly);
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  const clean = songResults.filter(r => r.issues.length === 0).length;
  console.log(`Total: ${toValidate.length} songs | ${clean} clean | ${totalErrors} errors | ${totalWarns} warnings`);

  if (totalErrors > 0) process.exit(1);
}

main().catch(console.error);
