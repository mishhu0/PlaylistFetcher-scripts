#!/usr/bin/env node

import fs from 'node:fs'
import https from 'node:https'
import { getNodeScriptUsage, resolveProfileMusicPath, resolveToolPath } from './tool-paths.js'

const SONGS_LIBRARY_PATH = resolveProfileMusicPath('songs-library.json')
const GENRE_LIBRARY_PATH = resolveProfileMusicPath('genre-library.json')
const GENRE_TODO_PATH = resolveToolPath('genre-todo.json')
const GENRE_SUGGESTIONS_PATH = resolveToolPath('genre-suggestions.json')
const GENRE_CACHE_PATH = resolveToolPath('genre-cache-musicbrainz.json')

const DEFAULT_USER_AGENT = 'profile-genre-helper/1.0 (github-copilot-local-script)'
const DEFAULT_MIN_SEARCH_SCORE = 80
const DEFAULT_APPLY_CONFIDENCE = 0.72
const DEFAULT_DELAY_MS = 1100

const TAG_ALIASES = {
  'progressive death metal': 'Prog Death Metal',
  'prog death metal': 'Prog Death Metal',
  'death metal': 'Metal',
  'progressive metal': 'Progressive Metal',
  'alternative metal': 'Alternative Metal',
  'post hardcore': 'Post-Hardcore',
  'post-hardcore': 'Post-Hardcore',
  'math rock': 'Math Rock',
  'indie rock': 'Indie Rock',
  'alt rock': 'Alternative Rock',
  'alternative rock': 'Alternative Rock',
  'progressive rock': 'Progressive Rock',
  'prog rock': 'Progressive Rock',
  'jazz funk': 'Jazz Funk',
  'jazz-funk': 'Jazz Funk',
  'jazz fusion': 'Jazz Fusion',
  'fusion': 'Jazz Fusion',
  'synth-pop': 'Synth Pop',
  'synth pop': 'Synth Pop',
  'dream pop': 'Dream Pop',
  'hip hop': 'Hip-Hop',
  'hip-hop': 'Hip-Hop',
  'drum and bass': 'Drum and Bass',
  'dnb': 'Drum and Bass',
  'nu disco': 'Nu Disco',
  'electronic': 'Electronic',
  'afrobeat': 'Afrobeat',
  'folk rock': 'Folk Rock',
  'blues rock': 'Blues Rock',
  'djent': 'Djent',
  'blackgaze': 'Blackgaze',
  'jazz punk': 'Jazz Punk',
  'indie pop': 'Indie Pop',
  'experimental rock': 'Experimental Rock',
  'tropical house': 'Tropical House',
  'metal': 'Metal',
  'jazz': 'Jazz'
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath)
    return true
  } catch {
    return false
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function stableTrackKey(artist, title) {
  return normalizeText(artist) + '||' + normalizeText(title)
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms)
  })
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    noCache: false,
    limit: 0,
    minSearchScore: DEFAULT_MIN_SEARCH_SCORE,
    applyConfidence: DEFAULT_APPLY_CONFIDENCE,
    delayMs: DEFAULT_DELAY_MS,
    userAgent: DEFAULT_USER_AGENT,
    help: false
  }

  for (let index = 0; index < argv.length; index++) {
    const token = String(argv[index] || '')

    if (token === '--dry-run') {
      args.dryRun = true
      continue
    }
    if (token === '--no-cache') {
      args.noCache = true
      continue
    }
    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    if (token === '--limit') {
      args.limit = Math.max(0, Number(argv[index + 1] || 0) | 0)
      index++
      continue
    }
    if (token === '--min-score') {
      const next = Number(argv[index + 1])
      args.minSearchScore = Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : DEFAULT_MIN_SEARCH_SCORE
      index++
      continue
    }
    if (token === '--apply-confidence') {
      const next = Number(argv[index + 1])
      args.applyConfidence = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : DEFAULT_APPLY_CONFIDENCE
      index++
      continue
    }
    if (token === '--delay-ms') {
      const next = Number(argv[index + 1])
      args.delayMs = Number.isFinite(next) ? Math.max(0, Math.floor(next)) : DEFAULT_DELAY_MS
      index++
      continue
    }
    if (token === '--user-agent') {
      args.userAgent = String(argv[index + 1] || '').trim() || DEFAULT_USER_AGENT
      index++
      continue
    }
  }

  return args
}

function printHelp() {
  console.log('Bulk genre suggestion helper (MusicBrainz)')
  console.log(`Usage: ${getNodeScriptUsage(import.meta.url)} [options]`)
  console.log('')
  console.log('Options:')
  console.log('  --dry-run                 Do not write songs-library.json')
  console.log('  --no-cache                Ignore existing MusicBrainz cache')
  console.log('  --limit <n>               Process only first n unknown tracks')
  console.log('  --min-score <0..100>      Minimum MusicBrainz search score (default: 80)')
  console.log('  --apply-confidence <0..1> Auto-apply threshold (default: 0.72)')
  console.log('  --delay-ms <n>            Delay between API calls (default: 1100)')
  console.log('  --user-agent <text>       Custom User-Agent header')
  console.log('  -h, --help                Show help')
}

function httpsGetJson(url, userAgent) {
  return new Promise(function(resolve, reject) {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/json'
        }
      },
      function(res) {
        const status = Number(res.statusCode || 0)
        let body = ''
        res.setEncoding('utf8')
        res.on('data', function(chunk) {
          body += chunk
        })
        res.on('end', function() {
          if (status < 200 || status >= 300) {
            reject(new Error('HTTP ' + status + ' for ' + url))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
  })
}

async function searchRecordings(artist, title, userAgent) {
  const query = `recording:"${title}" AND artist:"${artist}"`
  const url = new URL('https://musicbrainz.org/ws/2/recording/')
  url.searchParams.set('query', query)
  url.searchParams.set('fmt', 'json')
  url.searchParams.set('limit', '5')
  const response = await httpsGetJson(url.toString(), userAgent)
  return Array.isArray(response.recordings) ? response.recordings : []
}

async function fetchRecordingTags(recordingId, userAgent) {
  const url = new URL('https://musicbrainz.org/ws/2/recording/' + encodeURIComponent(recordingId))
  url.searchParams.set('inc', 'tags')
  url.searchParams.set('fmt', 'json')
  const response = await httpsGetJson(url.toString(), userAgent)
  return Array.isArray(response.tags) ? response.tags : []
}

function buildKnownGenreMap(genreLibrary) {
  const result = new Map()
  const genres = Array.isArray(genreLibrary && genreLibrary.genres) ? genreLibrary.genres : []
  genres.forEach(function(entry) {
    const genre = String(entry && entry.genre || '').trim()
    if (!genre) return
    result.set(normalizeText(genre), genre)
  })
  return result
}

function mapTagToCanonical(rawTagName, knownGenresByNorm) {
  const normalized = normalizeText(rawTagName)
  if (!normalized) return ''
  if (knownGenresByNorm.has(normalized)) return knownGenresByNorm.get(normalized)
  if (Object.prototype.hasOwnProperty.call(TAG_ALIASES, normalized)) return TAG_ALIASES[normalized]
  return ''
}

function scoreGenreCandidates(candidates, tags, knownGenresByNorm) {
  const totals = new Map()
  const details = []

  candidates.forEach(function(candidate) {
    const searchScore = Number(candidate && candidate.score || 0)
    const candidateTags = Array.isArray(tags.get(candidate.id)) ? tags.get(candidate.id) : []

    candidateTags.forEach(function(tag) {
      const rawName = String(tag && tag.name || '').trim()
      const canonical = mapTagToCanonical(rawName, knownGenresByNorm)
      if (!canonical) return

      const tagCount = Math.max(1, Number(tag && tag.count || 1))
      const weighted = tagCount * (0.5 + (searchScore / 200))
      totals.set(canonical, (totals.get(canonical) || 0) + weighted)
      details.push({
        genre: canonical,
        fromTag: rawName,
        tagCount,
        searchScore
      })
    })
  })

  const ranking = Array.from(totals.entries())
    .map(function(entry) {
      return { genre: entry[0], score: entry[1] }
    })
    .sort(function(a, b) {
      return b.score - a.score
    })

  return { ranking, details }
}

function estimateConfidence(topScore, secondScore, bestSearchScore) {
  if (!Number.isFinite(topScore) || topScore <= 0) return 0

  const dominance = topScore / (topScore + Math.max(0, secondScore) + 1)
  const searchFactor = Math.max(0, Math.min(1, bestSearchScore / 100))
  const confidence = (dominance * 0.7) + (searchFactor * 0.3)
  return Math.max(0, Math.min(1, confidence))
}

function collectUnknownTracks(library) {
  const output = []
  const sections = Array.isArray(library && library.sections) ? library.sections : []

  sections.forEach(function(section, sectionIndex) {
    const tracks = Array.isArray(section && section.tracks) ? section.tracks : []
    tracks.forEach(function(track, trackIndex) {
      const genre = String(track && track.genre || '').trim().toLowerCase()
      if (genre && genre !== 'unknown') return

      output.push({
        sectionIndex,
        trackIndex,
        track
      })
    })
  })

  return output
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  if (!fileExists(SONGS_LIBRARY_PATH)) {
    throw new Error('Missing songs library: ' + SONGS_LIBRARY_PATH)
  }
  if (!fileExists(GENRE_LIBRARY_PATH)) {
    throw new Error('Missing genre library: ' + GENRE_LIBRARY_PATH)
  }

  const library = readJson(SONGS_LIBRARY_PATH)
  const genreLibrary = readJson(GENRE_LIBRARY_PATH)
  const knownGenresByNorm = buildKnownGenreMap(genreLibrary)

  const cache = (!args.noCache && fileExists(GENRE_CACHE_PATH))
    ? readJson(GENRE_CACHE_PATH)
    : { updatedAt: new Date().toISOString(), items: {} }

  const unknownTracks = collectUnknownTracks(library)
  const targetTracks = args.limit > 0 ? unknownTracks.slice(0, args.limit) : unknownTracks

  const suggestionsReport = []
  const unresolvedTodo = []

  let autoAppliedCount = 0
  let cacheHitCount = 0
  let queriedCount = 0

  console.log('Starting genre suggestion run...')
  console.log('Unknown tracks found:', unknownTracks.length)
  console.log('Tracks to process this run:', targetTracks.length)

  for (let index = 0; index < targetTracks.length; index++) {
    const item = targetTracks[index]
    const track = item.track || {}
    const artist = String(track.artist || '').trim()
    const title = String(track.title || '').trim()
    const key = stableTrackKey(artist, title)

    const progressPrefix = '[' + String(index + 1) + '/' + String(targetTracks.length) + ']'
    console.log(progressPrefix, artist || 'Unknown artist', '-', title || 'Unknown title')

    if (!artist || !title) {
      unresolvedTodo.push({
        artist,
        title,
        file: track.file || '',
        reason: 'missing-artist-or-title',
        searchUrl: 'https://www.google.com/search?q=' + encodeURIComponent([artist, title, 'genre'].filter(Boolean).join(' '))
      })
      continue
    }

    let cached = cache.items && cache.items[key] ? cache.items[key] : null
    if (cached && cached.minSearchScore !== args.minSearchScore) {
      cached = null
    }

    if (cached) {
      cacheHitCount++
    }

    let result = cached
    if (!result) {
      try {
        queriedCount++

        const recordings = await searchRecordings(artist, title, args.userAgent)
        const candidates = recordings
          .filter(function(recording) {
            return Number(recording && recording.score || 0) >= args.minSearchScore && recording && recording.id
          })
          .slice(0, 3)

        const tagsByRecordingId = new Map()
        for (let c = 0; c < candidates.length; c++) {
          const candidate = candidates[c]
          const tags = await fetchRecordingTags(candidate.id, args.userAgent)
          tagsByRecordingId.set(candidate.id, tags)
          if (args.delayMs > 0) await sleep(args.delayMs)
        }

        const scored = scoreGenreCandidates(candidates, tagsByRecordingId, knownGenresByNorm)
        const top = scored.ranking[0] || null
        const second = scored.ranking[1] || null
        const bestSearchScore = candidates.reduce(function(max, candidate) {
          return Math.max(max, Number(candidate && candidate.score || 0))
        }, 0)

        const confidence = top ? estimateConfidence(top.score, second ? second.score : 0, bestSearchScore) : 0

        result = {
          updatedAt: new Date().toISOString(),
          minSearchScore: args.minSearchScore,
          artist,
          title,
          bestSearchScore,
          suggestedGenre: top ? top.genre : '',
          confidence,
          alternatives: scored.ranking.slice(0, 5),
          details: scored.details.slice(0, 20)
        }

        if (!cache.items) cache.items = {}
        cache.items[key] = result
        if (args.delayMs > 0) await sleep(args.delayMs)
      } catch (error) {
        const errorMessage = error && error.message ? error.message : String(error)
        console.warn(progressPrefix, 'MusicBrainz lookup failed:', errorMessage)
        unresolvedTodo.push({
          artist,
          title,
          file: track.file || '',
          reason: 'lookup-failed',
          error: errorMessage,
          searchUrl: 'https://www.google.com/search?q=' + encodeURIComponent([artist, title, 'genre'].filter(Boolean).join(' '))
        })
        continue
      }
    }

    const suggestedGenre = String(result && result.suggestedGenre || '').trim()
    const confidence = Number(result && result.confidence || 0)
    const shouldApply = Boolean(suggestedGenre) && confidence >= args.applyConfidence

    suggestionsReport.push({
      artist,
      title,
      file: track.file || '',
      suggestedGenre,
      confidence,
      bestSearchScore: Number(result && result.bestSearchScore || 0),
      alternatives: Array.isArray(result && result.alternatives) ? result.alternatives : [],
      autoApplied: shouldApply && !args.dryRun
    })

    if (shouldApply) {
      if (!args.dryRun) {
        library.sections[item.sectionIndex].tracks[item.trackIndex].genre = suggestedGenre
      }
      autoAppliedCount++
      continue
    }

    unresolvedTodo.push({
      artist,
      title,
      file: track.file || '',
      suggestedGenre,
      confidence,
      searchUrl: 'https://www.google.com/search?q=' + encodeURIComponent([artist, title, 'genre'].filter(Boolean).join(' '))
    })
  }

  cache.updatedAt = new Date().toISOString()
  if (!args.noCache) {
    writeJson(GENRE_CACHE_PATH, cache)
  }

  if (!args.dryRun) {
    writeJson(SONGS_LIBRARY_PATH, library)
  }

  writeJson(GENRE_SUGGESTIONS_PATH, {
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    minSearchScore: args.minSearchScore,
    applyConfidence: args.applyConfidence,
    processedTracks: targetTracks.length,
    autoAppliedCount,
    unresolvedCount: unresolvedTodo.length,
    items: suggestionsReport
  })

  writeJson(GENRE_TODO_PATH, {
    generatedAt: new Date().toISOString(),
    source: 'suggest-genres.js',
    dryRun: args.dryRun,
    items: unresolvedTodo
  })

  console.log('Genre suggestion run complete')
  console.log('Processed unknown tracks:', targetTracks.length)
  console.log('MusicBrainz queried:', queriedCount)
  console.log('Cache hits:', cacheHitCount)
  console.log('Auto-applied:', autoAppliedCount)
  console.log('Unresolved / todo:', unresolvedTodo.length)
  console.log('Suggestions report:', GENRE_SUGGESTIONS_PATH)
  console.log('Genre todo:', GENRE_TODO_PATH)
  if (args.dryRun) {
    console.log('Dry run enabled: songs-library.json was not modified')
  }
}

main().catch(function(error) {
  console.error('Error:', error && error.message ? error.message : error)
  process.exit(1)
})
