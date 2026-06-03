#!/usr/bin/env node

import fs from 'node:fs'
import https from 'node:https'
import { getNodeScriptUsage, resolveSongsLibraryPath, resolveToolPath } from './tool-paths.js'

const SONGS_LIBRARY_PATH = resolveSongsLibraryPath()
const CACHE_PATH = resolveToolPath('genre-cache-itunes.json')

const DEFAULT_DELAY_MS = 150

const ITUNES_TO_CANONICAL = {
  'alternative': 'Alternative Rock',
  'alternative rock': 'Alternative Rock',
  'rock': 'Alternative Rock',
  'indie rock': 'Indie Rock',
  'metal': 'Metal',
  'heavy metal': 'Metal',
  'hip-hop/rap': 'Hip-Hop',
  'hip-hop': 'Hip-Hop',
  'rap': 'Hip-Hop',
  'electronic': 'Electronic',
  'dance': 'Electronic',
  'house': 'Electronic',
  'r&b/soul': 'Indie Pop',
  'soul': 'Indie Pop',
  'pop': 'Indie Pop',
  'indie pop': 'Indie Pop',
  'jazz': 'Jazz',
  'jazz fusion': 'Jazz Fusion',
  'blues': 'Blues Rock',
  'reggae': 'Afrobeat',
  'folk': 'Folk Rock'
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
    delayMs: DEFAULT_DELAY_MS,
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
    if (token === '--limit') {
      args.limit = Math.max(0, Number(argv[i + 1] || 0) | 0)
      i++
      continue
    }
    if (token === '--delay-ms') {
      const next = Number(argv[i + 1])
      args.delayMs = Number.isFinite(next) ? Math.max(0, Math.floor(next)) : DEFAULT_DELAY_MS
      i++
      continue
    }
  }

  return args
}

function printHelp() {
  console.log('Fill MISC genres via iTunes Search API')
  console.log(`Usage: ${getNodeScriptUsage(import.meta.url)} [options]`)
  console.log('  --dry-run')
  console.log('  --no-cache')
  console.log('  --limit <n>')
  console.log('  --delay-ms <n>')
}

function httpsGetJson(url) {
  return new Promise(function(resolve, reject) {
    const req = https.get(url, function(res) {
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
    })
    req.on('error', reject)
  })
}

function canonicalizeItunesGenre(value) {
  const norm = normalizeText(value)
  if (!norm) return ''
  return ITUNES_TO_CANONICAL[norm] || ''
}

function similarity(a, b) {
  const aa = normalizeText(a)
  const bb = normalizeText(b)
  if (!aa || !bb) return 0
  if (aa === bb) return 1
  if (aa.includes(bb) || bb.includes(aa)) return 0.82

  const aSet = new Set(aa.split(' ').filter(Boolean))
  const bSet = new Set(bb.split(' ').filter(Boolean))
  const inter = [...aSet].filter(function(x) { return bSet.has(x) }).length
  const union = new Set([...aSet, ...bSet]).size || 1
  return inter / union
}

async function lookupItunesGenre(artist, title) {
  const term = encodeURIComponent([artist, title].filter(Boolean).join(' '))
  const url = 'https://itunes.apple.com/search?entity=song&limit=8&term=' + term
  const data = await httpsGetJson(url)
  const results = Array.isArray(data && data.results) ? data.results : []

  let best = null
  let bestScore = 0

  for (const result of results) {
    const genre = canonicalizeItunesGenre(result && result.primaryGenreName)
    if (!genre) continue

    const artistScore = similarity(artist, result && result.artistName)
    const titleScore = similarity(title, result && result.trackName)
    const score = (artistScore * 0.6) + (titleScore * 0.4)

    if (score > bestScore) {
      bestScore = score
      best = {
        genre,
        score,
        sourceGenre: String(result && result.primaryGenreName || '')
      }
    }
  }

  if (!best || best.score < 0.55) return null
  return best
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const library = readJson(SONGS_LIBRARY_PATH)
  const cache = (!args.noCache && fileExists(CACHE_PATH))
    ? readJson(CACHE_PATH)
    : { updatedAt: new Date().toISOString(), items: {} }

  const tracks = []
  for (const section of (library.sections || [])) {
    for (const track of (section.tracks || [])) tracks.push(track)
  }

  let targets = tracks.filter(function(track) {
    const genre = String(track && track.genre || '').trim().toLowerCase()
    return !genre || genre === 'unknown' || genre === 'misc'
  })

  if (args.limit > 0) targets = targets.slice(0, args.limit)

  console.log('Tracks to infer via iTunes:', targets.length)

  let applied = 0
  let queried = 0
  let cacheHits = 0

  for (let i = 0; i < targets.length; i++) {
    const track = targets[i]
    const artist = String(track.artist || '').trim()
    const title = String(track.title || '').trim()
    const key = stableTrackKey(artist, title)
    const progress = '[' + String(i + 1) + '/' + String(targets.length) + ']'

    let cached = cache.items && cache.items[key] ? cache.items[key] : null
    if (cached) cacheHits++

    let pick = cached && cached.genre ? cached : null
    if (!pick) {
      try {
        queried++
        const lookedUp = await lookupItunesGenre(artist, title)
        pick = lookedUp ? lookedUp : null
        if (!cache.items) cache.items = {}
        cache.items[key] = pick ? {
          updatedAt: new Date().toISOString(),
          genre: pick.genre,
          score: pick.score,
          sourceGenre: pick.sourceGenre
        } : {
          updatedAt: new Date().toISOString(),
          genre: '',
          score: 0,
          sourceGenre: ''
        }
      } catch (error) {
        const msg = error && error.message ? error.message : String(error)
        console.warn(progress, 'lookup failed:', msg)
      }

      if (args.delayMs > 0) await sleep(args.delayMs)
    }

    if (!pick || !pick.genre) continue
    track.genre = pick.genre
    applied++
  }

  cache.updatedAt = new Date().toISOString()
  if (!args.noCache) writeJson(CACHE_PATH, cache)
  if (!args.dryRun) writeJson(SONGS_LIBRARY_PATH, library)

  const unknownAfter = tracks.filter(function(track) {
    const g = String(track && track.genre || '').trim().toLowerCase()
    return !g || g === 'unknown'
  }).length
  const miscAfter = tracks.filter(function(track) {
    return String(track && track.genre || '').trim() === 'MISC'
  }).length

  console.log('Applied tracks:', applied)
  console.log('Queried:', queried)
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
