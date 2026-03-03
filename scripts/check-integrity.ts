#!/usr/bin/env bun
/**
 * Lyrics Integrity Check
 *
 * Compares LRCLIB/songs.json lyrics against WhisperX transcripts to detect
 * text mismatches (wrong version, missing sections, different arrangement).
 *
 * Requires WhisperX JSON files in scripts/srt-timestamps/
 *
 * Usage:
 *   bun scripts/check-integrity.ts              # Check all songs with WhisperX data
 *   bun scripts/check-integrity.ts SONG_ID      # Check specific song
 */

import { readFile, readdir } from 'fs/promises';
import { join, basename } from 'path';

const ROOT = '/home/debian/apex/x/code/lyric';
const DATA_PATH = join(ROOT, 'data/songs.json');
const SRT_DIR = join(ROOT, 'scripts/srt-timestamps');

interface LyricLine {
  chinese: string;
  [key: string]: any;
}
interface Song {
  id: string;
  title: string;
  artist: string;
  hasLyrics: boolean;
  lyricsSource?: string;
  lyrics?: LyricLine[];
}
interface WhisperXSegment {
  start: number;
  end: number;
  text: string;
}
interface WhisperXData {
  segments: WhisperXSegment[];
  word_segments?: any[];
  language?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isChinese(ch: string): boolean {
  const code = ch.codePointAt(0) || 0;
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

function extractChineseChars(text: string): string {
  return [...text].filter(isChinese).join('');
}

/** Build set of character bigrams for Jaccard similarity */
function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) {
    set.add(text.slice(i, i + 2));
  }
  return set;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** What fraction of chars in `needle` appear in `haystack` */
function charCoverage(needle: string, haystack: string): number {
  if (needle.length === 0) return 1;
  const haystackChars = new Set([...haystack]);
  let covered = 0;
  for (const ch of needle) {
    if (haystackChars.has(ch)) covered++;
  }
  return covered / needle.length;
}

/** Simple traditional→simplified normalization for common pairs */
const TRAD_TO_SIMP: Record<string, string> = {
  '愛': '爱', '說': '说', '點': '点', '會': '会', '這': '这', '過': '过',
  '還': '还', '讓': '让', '開': '开', '對': '对', '當': '当', '裡': '里',
  '從': '从', '後': '后', '為': '为', '麼': '么', '東': '东', '長': '长',
  '時': '时', '與': '与', '給': '给', '話': '话', '國': '国', '間': '间',
  '頭': '头', '見': '见', '們': '们', '問': '问', '學': '学', '難': '难',
  '聽': '听', '親': '亲', '關': '关', '歡': '欢', '書': '书', '飛': '飞',
  '風': '风', '夢': '梦', '輕': '轻', '雲': '云', '歲': '岁', '遠': '远',
  '樂': '乐', '邊': '边', '燈': '灯', '機': '机', '實': '实', '動': '动',
  '變': '变', '記': '记', '離': '离', '認': '认', '該': '该', '錯': '错',
  '請': '请', '處': '处', '帶': '带', '買': '买', '結': '结', '經': '经',
  '場': '场', '體': '体', '華': '华', '標': '标', '號': '号', '詞': '词',
  '義': '义', '電': '电', '無': '无', '類': '类', '節': '节', '論': '论',
  '條': '条', '線': '线', '語': '语', '產': '产', '車': '车', '報': '报',
  '選': '选', '識': '识', '運': '运', '響': '响', '連': '连', '單': '单',
  '滿': '满', '衛': '卫', '準': '准', '傳': '传', '議': '议', '設': '设',
  '確': '确', '壞': '坏', '環': '环', '屬': '属', '隨': '随', '雞': '鸡',
  '習': '习', '調': '调', '勝': '胜', '積': '积', '練': '练', '紅': '红',
  '裝': '装', '規': '规', '觀': '观', '覺': '觉', '剛': '刚', '達': '达',
};

function normalizeChars(text: string): string {
  return [...text].map(ch => TRAD_TO_SIMP[ch] || ch).join('');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const songId = args.find(a => !a.startsWith('--'));

  const songs: Song[] = JSON.parse(await readFile(DATA_PATH, 'utf-8'));
  const files = await readdir(SRT_DIR);

  // Find WhisperX JSON files (prefer -demucs variants)
  const whisperxFiles = new Map<string, string>();
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.orig-whisperx')) continue;
    const id = f.replace(/-demucs\.json$/, '').replace(/-prompted\.json$/, '').replace(/\.json$/, '');
    // Prefer demucs version
    if (f.includes('-demucs') || !whisperxFiles.has(id)) {
      whisperxFiles.set(id, join(SRT_DIR, f));
    }
  }

  // Filter to requested songs
  const toCheck = songId
    ? songs.filter(s => s.id === songId || s.title.includes(songId))
    : songs.filter(s => s.hasLyrics && whisperxFiles.has(s.id));

  if (toCheck.length === 0) {
    if (songId) {
      console.log(`No song found matching "${songId}" with WhisperX data`);
    } else {
      console.log('No songs with both lyrics and WhisperX data');
    }
    return;
  }

  console.log(`Checking lyrics integrity for ${toCheck.length} song(s)...\n`);

  for (const song of toCheck) {
    const whisperxPath = whisperxFiles.get(song.id);
    if (!whisperxPath) {
      console.log(`⊘  ${song.title} — ${song.artist} (${song.id})`);
      console.log(`   No WhisperX data available\n`);
      continue;
    }

    const wxData: WhisperXData = JSON.parse(await readFile(whisperxPath, 'utf-8'));

    // Extract Chinese text from WhisperX transcript
    const wxText = wxData.segments.map(s => s.text).join('');
    const wxChinese = normalizeChars(extractChineseChars(wxText));

    // Extract Chinese text from lyrics
    const lyricsText = (song.lyrics || []).map(l => l.chinese || '').join('');
    const lyricsChinese = normalizeChars(extractChineseChars(lyricsText));

    // Metrics
    const wxBigrams = bigrams(wxChinese);
    const lyricsBigrams = bigrams(lyricsChinese);
    const jaccard = jaccardSimilarity(wxBigrams, lyricsBigrams);

    // Coverage: what % of lyrics chars appear in transcript (and vice versa)
    const lyricsCoveredByWx = charCoverage(lyricsChinese, wxChinese);
    const wxCoveredByLyrics = charCoverage(wxChinese, lyricsChinese);

    // Unique chars comparison
    const wxUniqueChars = new Set([...wxChinese]);
    const lyricsUniqueChars = new Set([...lyricsChinese]);
    let sharedChars = 0;
    for (const ch of wxUniqueChars) {
      if (lyricsUniqueChars.has(ch)) sharedChars++;
    }
    const charJaccard = (wxUniqueChars.size + lyricsUniqueChars.size - sharedChars) === 0
      ? 0
      : sharedChars / (wxUniqueChars.size + lyricsUniqueChars.size - sharedChars);

    // Only in WhisperX (chars the audio has that lyrics don't)
    const onlyInWx = [...wxUniqueChars].filter(ch => !lyricsUniqueChars.has(ch));
    // Only in lyrics (chars lyrics have that audio doesn't)
    const onlyInLyrics = [...lyricsUniqueChars].filter(ch => !wxUniqueChars.has(ch));

    // Verdict
    let status: string;
    let verdict: string;
    if (jaccard >= 0.7 && lyricsCoveredByWx >= 0.85) {
      status = '✅';
      verdict = 'Good match';
    } else if (jaccard >= 0.4 || lyricsCoveredByWx >= 0.7) {
      status = '⚠️';
      verdict = 'Partial match — verify lyrics version';
    } else {
      status = '❌';
      verdict = 'Poor match — likely wrong lyrics version';
    }

    const wxFile = basename(whisperxPath);
    console.log(`${status} ${song.title} — ${song.artist} (${song.id})`);
    console.log(`   Source: ${song.lyricsSource || 'unknown'} | WhisperX: ${wxFile}`);
    console.log(`   Lyrics chars: ${lyricsChinese.length} | Transcript chars: ${wxChinese.length} | Ratio: ${(lyricsChinese.length / (wxChinese.length || 1)).toFixed(2)}`);
    console.log(`   Bigram Jaccard: ${(jaccard * 100).toFixed(1)}% | Char vocab Jaccard: ${(charJaccard * 100).toFixed(1)}%`);
    console.log(`   Lyrics→Transcript coverage: ${(lyricsCoveredByWx * 100).toFixed(1)}% | Transcript→Lyrics: ${(wxCoveredByLyrics * 100).toFixed(1)}%`);
    console.log(`   Verdict: ${verdict}`);

    if (onlyInWx.length > 0 && onlyInWx.length <= 20) {
      console.log(`   Only in transcript: ${onlyInWx.join('')}`);
    }
    if (onlyInLyrics.length > 0 && onlyInLyrics.length <= 20) {
      console.log(`   Only in lyrics: ${onlyInLyrics.join('')}`);
    }

    console.log();
  }
}

main().catch(console.error);
