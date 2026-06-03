#!/usr/bin/env node

import fs from 'node:fs'
import https from 'node:https'
import { getNodeScriptUsage, resolveProfileMusicPath, resolveToolPath } from './tool-paths.js'

const SONGS_LIBRARY_PATH = resolveProfileMusicPath('songs-library.json')
const GENRE_LIBRARY_PATH = resolveProfileMusicPath('genre-library.json')
const ARTIST_CACHE_PATH = resolveToolPath('artist-genre-cache-musicbrainz.json')

const DEFAULT_USER_AGENT = 'profile-artist-genre-helper/1.0 (github-copilot-local-script)'
const DEFAULT_MIN_SEARCH_SCORE = 75
const DEFAULT_DELAY_MS = 900

const TAG_ALIASES = {
  'progressive death metal': 'Prog Death Metal',
  'prog death metal': 'Prog Death Metal',
  'progressive metal': 'Progressive Metal',
  'alternative metal': 'Alternative Metal',
  'post hardcore': 'Post-Hardcore',
  'post-hardcore': 'Post-Hardcore',
  'math rock': 'Math Rock',
  'indie rock': 'Indie Rock',
  'alternative rock': 'Alternative Rock',
  'progressive rock': 'Progressive Rock',
  'jazz funk': 'Jazz Funk',
  'jazz fusion': 'Jazz Fusion',
  'synth pop': 'Synth Pop',
  'dream pop': 'Dream Pop',
  'hip hop': 'Hip-Hop',
  'hip-hop': 'Hip-Hop',
  'drum and bass': 'Drum and Bass',
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

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms)
  })
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    noCache: false,
    limitArtists: 0,
    delayMs: DEFAULT_DELAY_MS,
    minSearchScore: DEFAULT_MIN_SEARCH_SCORE,
    userAgent: DEFAULT_USER_AGENT,
    maxRetries: 3,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] || '')
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
    if (token === '--limit-artists') {
      args.limitArtists = Math.max(0, Number(argv[i + 1] || 0) | 0)
      i++
      continue
    }
    if (token === '--delay-ms') {
      const next = Number(argv[i + 1])
      args.delayMs = Number.isFinite(next) ? Math.max(0, Math.floor(next)) : DEFAULT_DELAY_MS
      i++
      continue
    }
    if (token === '--min-score') {
      const next = Number(argv[i + 1])
      args.minSearchScore = Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : DEFAULT_MIN_SEARCH_SCORE
      i++
      continue
    }
    if (token === '--max-retries') {
      const next = Number(argv[i + 1])
      args.maxRetries = Number.isFinite(next) ? Math.max(0, Math.floor(next)) : 3
      i++
      continue
    }
  }

  return args
}

function printHelp() {
  console.log('Fill MISC genres by artist tags (MusicBrainz)')
  console.log(`Usage: ${getNodeScriptUsage(import.meta.url)} [options]`)
  console.log('  --dry-run')
  console.log('  --no-cache')
  console.log('  --limit-artists <n>')
  console.log('  --delay-ms <n>')
  console.log('  --min-score <0..100>')
  console.log('  --max-retries <n>')
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
            const error = new Error('HTTP ' + status + ' for ' + url)
            error.statusCode = status
            reject(error)
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

async function httpsGetJsonWithRetry(url, userAgent, maxRetries) {
  let attempt = 0
  while (true) {
    try {
      return await httpsGetJson(url, userAgent)
    } catch (error) {
      const statusCode = Number(error && error.statusCode || 0)
      const retriable = statusCode === 429 || statusCode === 503
      if (!retriable || attempt >= maxRetries) throw error
      const backoffMs = Math.min(8000, 750 * Math.pow(2, attempt))
      await sleep(backoffMs)
      attempt++
    }
  }
}

async function searchArtists(artistName, userAgent, maxRetries) {
  const url = new URL('https://musicbrainz.org/ws/2/artist/')
  url.searchParams.set('query', `artist:"${artistName}"`)
  url.searchParams.set('fmt', 'json')
  url.searchParams.set('limit', '5')
  const response = await httpsGetJsonWithRetry(url.toString(), userAgent, maxRetries)
  return Array.isArray(response.artists) ? response.artists : []
}

async function fetchArtistTags(artistId, userAgent, maxRetries) {
  const url = new URL('https://musicbrainz.org/ws/2/artist/' + encodeURIComponent(artistId))
  url.searchParams.set('inc', 'tags')
  url.searchParams.set('fmt', 'json')
  const response = await httpsGetJsonWithRetry(url.toString(), userAgent, maxRetries)
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

function canonicalFromTag(tag, knownGenresByNorm) {
  const norm = normalizeText(tag)
  if (!norm) return ''
  if (knownGenresByNorm.has(norm)) return knownGenresByNorm.get(norm)
  if (Object.prototype.hasOwnProperty.call(TAG_ALIASES, norm)) return TAG_ALIASES[norm]
  return ''
}

function pickGenreFromArtists(candidates, tagsByArtistId, knownGenresByNorm) {
  const totals = new Map()

  for (const candidate of candidates) {
    const score = Number(candidate && candidate.score || 0)
    const tags = tagsByArtistId.get(candidate.id) || []
    for (const tag of tags) {
      const canonical = canonicalFromTag(String(tag && tag.name || ''), knownGenresByNorm)
      if (!canonical) continue
      const count = Math.max(1, Number(tag && tag.count || 1))
      const weight = count * (0.5 + (score / 200))
      totals.set(canonical, (totals.get(canonical) || 0) + weight)
    }
  }

  let topGenre = ''
  let topScore = 0
  for (const [genre, score] of totals.entries()) {
    if (score > topScore) {
      topGenre = genre
      topScore = score
    }
  }

  return topGenre
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const library = readJson(SONGS_LIBRARY_PATH)
  const genreLibrary = readJson(GENRE_LIBRARY_PATH)
  const knownGenresByNorm = buildKnownGenreMap(genreLibrary)

  const cache = (!args.noCache && fileExists(ARTIST_CACHE_PATH))
    ? readJson(ARTIST_CACHE_PATH)
    : { updatedAt: new Date().toISOString(), items: {} }

  const tracks = []
  for (const section of (library.sections || [])) {
    for (const track of (section.tracks || [])) {
      tracks.push(track)
    }
  }

  const targetTracks = tracks.filter(function(track) {
    const g = String(track && track.genre || '').trim().toLowerCase()
    return !g || g === 'unknown' || g === 'misc'
  })

  const artistMap = new Map()
  for (const track of targetTracks) {
    const artist = String(track && track.artist || '').trim()
    const norm = normalizeText(artist)
    if (!norm) continue
    if (!artistMap.has(norm)) {
      artistMap.set(norm, { artist, tracks: [] })
    }
    artistMap.get(norm).tracks.push(track)
  }

  let artists = Array.from(artistMap.values())
  if (args.limitArtists > 0) {
    artists = artists.slice(0, args.limitArtists)
  }

  console.log('Artists to infer:', artists.length)

  let applied = 0
  let queried = 0
  let cacheHits = 0

  for (let i = 0; i < artists.length; i++) {
    const entry = artists[i]
    const artistNorm = normalizeText(entry.artist)
    const progress = '[' + String(i + 1) + '/' + String(artists.length) + ']'
    console.log(progress, entry.artist)

    let cached = cache.items && cache.items[artistNorm] ? cache.items[artistNorm] : null
    if (cached) cacheHits++

    let genre = cached ? String(cached.genre || '').trim() : ''

    if (!genre) {
      try {
        queried++
        const results = await searchArtists(entry.artist, args.userAgent, args.maxRetries)
        const candidates = results
          .filter(function(artist) {
            return Number(artist && artist.score || 0) >= args.minSearchScore && artist && artist.id
          })
          .slice(0, 3)

        const tagsByArtistId = new Map()
        for (const candidate of candidates) {
          const tags = await fetchArtistTags(candidate.id, args.userAgent, args.maxRetries)
          tagsByArtistId.set(candidate.id, tags)
          if (args.delayMs > 0) await sleep(args.delayMs)
        }

        genre = pickGenreFromArtists(candidates, tagsByArtistId, knownGenresByNorm)
        if (!cache.items) cache.items = {}
        cache.items[artistNorm] = {
          updatedAt: new Date().toISOString(),
          artist: entry.artist,
          genre
        }
      } catch (error) {
        const msg = error && error.message ? error.message : String(error)
        console.warn(progress, 'lookup failed:', msg)
      }
    }

    if (!genre) continue

    for (const track of entry.tracks) {
      const current = String(track.genre || '').trim().toLowerCase()
      if (current && current !== 'unknown' && current !== 'misc') continue
      track.genre = genre
      applied++
    }
  }

  cache.updatedAt = new Date().toISOString()
  if (!args.noCache) {
    writeJson(ARTIST_CACHE_PATH, cache)
  }

  if (!args.dryRun) {
    writeJson(SONGS_LIBRARY_PATH, library)
  }

  const unknownAfter = tracks.filter(function(track) {
    const g = String(track && track.genre || '').trim().toLowerCase()
    return !g || g === 'unknown'
  }).length
  const miscAfter = tracks.filter(function(track) {
    return String(track && track.genre || '').trim() === 'MISC'
  }).length

  console.log('Applied tracks:', applied)
  console.log('Queried artists:', queried)
  console.log('Cache hits:', cacheHits)
  console.log('Remaining unknown:', unknownAfter)
  console.log('Remaining MISC:', miscAfter)
  if (args.dryRun) {
    console.log('Dry run enabled: songs-library.json unchanged')
  }
}

main().catch(function(error) {
  console.error('Error:', error && error.message ? error.message : error)
  process.exit(1)
})
