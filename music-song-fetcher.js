#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { getNodeScriptUsage, getToolRelativePath, resolveProfileMusicPath, resolveToolPath } from './tool-paths.js'

const LOCAL_CONFIG_PATH = resolveToolPath('music-song-fetcher.config.local.json')
const LOCAL_CONFIG_LABEL = getToolRelativePath('music-song-fetcher.config.local.json')
const DEFAULT_PLAYLIST_ID_FALLBACK = 'PLMesbUqWAwDTx3oi0sdKM6Ro0c6V23W2Y'
const DEFAULT_PLAYLIST_TITLE_FALLBACK = 'YouTube Playlist'
const DEFAULT_OUTPUT_PATH = resolveProfileMusicPath('fetched-songs-ytb-api.json')
const CONFIG_PLACEHOLDERS = new Set([
	'PUT_YOUR_YOUTUBE_API_KEY_HERE',
	'PUT_YOUR_YOUTUBE_PLAYLIST_ID_HERE',
	'PUT_YOUR_YOUTUBE_PLAYLIST_TITLE_HERE'
])

function normalizeConfiguredText(value) {
	const text = String(value || '').trim()
	if (!text) return ''
	return CONFIG_PLACEHOLDERS.has(text) ? '' : text
}

function loadLocalConfig() {
	if (!fs.existsSync(LOCAL_CONFIG_PATH)) {
		return {}
	}

	const content = fs.readFileSync(LOCAL_CONFIG_PATH, 'utf-8')
	let parsed

	try {
		parsed = JSON.parse(content)
	} catch (error) {
		throw new Error(`Invalid JSON in ${LOCAL_CONFIG_LABEL}: ${error.message}`)
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${LOCAL_CONFIG_LABEL}: expected a JSON object.`)
	}

	return parsed
}

function buildDefaultConfig() {
	const localConfig = loadLocalConfig()
	const configuredOutPath = normalizeConfiguredText(localConfig.outPath)

	return {
		apiKey: String(process.env.YOUTUBE_API_KEY || normalizeConfiguredText(localConfig.apiKey) || '').trim(),
		playlistId: String(process.env.YOUTUBE_PLAYLIST_ID || normalizeConfiguredText(localConfig.playlistId) || DEFAULT_PLAYLIST_ID_FALLBACK).trim(),
		playlistTitle: String(process.env.YOUTUBE_PLAYLIST_TITLE || normalizeConfiguredText(localConfig.playlistTitle) || DEFAULT_PLAYLIST_TITLE_FALLBACK).trim() || DEFAULT_PLAYLIST_TITLE_FALLBACK,
		outPath: process.env.YOUTUBE_FETCHED_JSON_OUT
			? path.resolve(process.env.YOUTUBE_FETCHED_JSON_OUT)
			: (configuredOutPath ? path.resolve(configuredOutPath) : DEFAULT_OUTPUT_PATH)
	}
}

function clampMaxResults(value) {
	const numeric = Number(value)
	if (!Number.isFinite(numeric)) return 50
	return Math.max(1, Math.min(50, Math.floor(numeric)))
}

function formatDuration(isoDuration) {
	const match = String(isoDuration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
	if (!match) return ''

	const hours = Number(match[1] || 0)
	const minutes = Number(match[2] || 0)
	const seconds = Number(match[3] || 0)

	const paddedMinutes = String(hours > 0 ? minutes : minutes + hours * 60).padStart(2, '0')
	const paddedSeconds = String(seconds).padStart(2, '0')

	if (hours > 0) {
		return hours + ':' + paddedMinutes + ':' + paddedSeconds
	}

	return minutes + ':' + paddedSeconds
}

function printHelp(defaultConfig) {
	console.log(`YouTube playlist fetcher (Node.js)

Writes the fetched playlist JSON to: ${path.relative(process.cwd(), defaultConfig.outPath)}

Usage:
	${getNodeScriptUsage(import.meta.url)} [options]

Config priority:
	1. CLI flags
	2. environment variables
	3. local JSON config: ${LOCAL_CONFIG_LABEL}

Options:
	--api-key <key>         YouTube Data API key (or env YOUTUBE_API_KEY / local config)
	--playlist-id <id>      YouTube playlist id (or env YOUTUBE_PLAYLIST_ID / local config)
	--title <title>         Playlist title label (or env YOUTUBE_PLAYLIST_TITLE / local config)
  --max-results <1-50>    Page size (default: 50)
	--out <path>            Output JSON path (or env YOUTUBE_FETCHED_JSON_OUT / local config)
  --stdout                Print JSON to stdout (do not write file)
  -h, --help              Show help
`)
}

function parseArgs(argv) {
	const args = {
		apiKey: '',
		playlistId: '',
		title: '',
		maxResults: 50,
		outPath: '',
		stdout: false,
		help: false
	}

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index]
		if (token === '-h' || token === '--help') {
			args.help = true
			continue
		}
		if (token === '--stdout') {
			args.stdout = true
			continue
		}
		if (token === '--api-key') {
			args.apiKey = String(argv[index + 1] || '')
			index++
			continue
		}
		if (token === '--playlist-id') {
			args.playlistId = String(argv[index + 1] || '')
			index++
			continue
		}
		if (token === '--title') {
			args.title = String(argv[index + 1] || '')
			index++
			continue
		}
		if (token === '--max-results') {
			args.maxResults = clampMaxResults(argv[index + 1])
			index++
			continue
		}
		if (token === '--out') {
			args.outPath = String(argv[index + 1] || '')
			index++
			continue
		}
	}

	return args
}

function httpsGetJson(url) {
	return new Promise(function(resolve, reject) {
		https
			.get(url, function(res) {
				const status = Number(res.statusCode || 0)
				let body = ''
				res.setEncoding('utf8')
				res.on('data', function(chunk) {
					body += chunk
				})
				res.on('end', function() {
					if (status < 200 || status >= 300) {
						reject(new Error('Request failed: ' + status + ' ' + (res.statusMessage || '') + '\n' + body))
						return
					}

					try {
						resolve(JSON.parse(body))
					} catch (error) {
						reject(error)
					}
				})
			})
			.on('error', reject)
	})
}

async function fetchPlaylistPage(config, pageToken) {
	const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems')
	url.searchParams.set('part', 'snippet,contentDetails')
	url.searchParams.set('maxResults', String(config.maxResults))
	url.searchParams.set('playlistId', config.playlistId)
	url.searchParams.set('key', config.apiKey)

	if (pageToken) {
		url.searchParams.set('pageToken', pageToken)
	}

	return httpsGetJson(url.toString())
}

async function fetchVideoDetails(config, videoIds) {
	const resultMap = new Map()
	const ids = Array.isArray(videoIds) ? videoIds.filter(Boolean) : []

	for (let index = 0; index < ids.length; index += 50) {
		const batch = ids.slice(index, index + 50)
		const url = new URL('https://www.googleapis.com/youtube/v3/videos')
		url.searchParams.set('part', 'snippet,contentDetails')
		url.searchParams.set('id', batch.join(','))
		url.searchParams.set('key', config.apiKey)

		const response = await httpsGetJson(url.toString())
		const items = Array.isArray(response.items) ? response.items : []

		items.forEach(function(item) {
			if (!item || !item.id) return
			resultMap.set(item.id, item)
		})
	}

	return resultMap
}

function toTrack(item, videoDetails, playlistId) {
	const snippet = item && item.snippet ? item.snippet : {}
	const videoId = snippet.resourceId && snippet.resourceId.videoId
		? String(snippet.resourceId.videoId)
		: String(item && item.contentDetails && item.contentDetails.videoId ? item.contentDetails.videoId : '')
	const videoSnippet = videoDetails && videoDetails.snippet ? videoDetails.snippet : {}
	const contentDetails = videoDetails && videoDetails.contentDetails ? videoDetails.contentDetails : {}
	const title = String(snippet.title || videoSnippet.title || 'Untitled track')
	const artist = String(videoSnippet.channelTitle || snippet.videoOwnerChannelTitle || 'YouTube')

	return {
		id: videoId || String(item && item.id ? item.id : title),
		title: title,
		artist: artist,
		genre: 'YouTube',
		file: '',
		downloadable: false,
		youtubeVideoId: videoId,
		youtubeUrl: videoId ? 'https://www.youtube.com/watch?v=' + videoId + '&list=' + playlistId : '',
		thumbnail: (videoSnippet.thumbnails && (videoSnippet.thumbnails.medium || videoSnippet.thumbnails.default || videoSnippet.thumbnails.high) || snippet.thumbnails && (snippet.thumbnails.medium || snippet.thumbnails.default || snippet.thumbnails.high) || {}).url || '',
		duration: formatDuration(contentDetails.duration || ''),
		publishedAt: videoSnippet.publishedAt || snippet.publishedAt || ''
	}
}

function toOutputJson(result) {
	return JSON.stringify(result, null, 2) + '\n'
}

function writeOutput(outPath, jsonText) {
	fs.mkdirSync(path.dirname(outPath), { recursive: true })
	fs.writeFileSync(outPath, jsonText, 'utf-8')
}

async function fetchPlaylistSongs(config) {
	const items = []
	let pageToken = ''

	do {
		const page = await fetchPlaylistPage(config, pageToken)
		const pageItems = Array.isArray(page.items) ? page.items : []
		items.push.apply(items, pageItems)
		pageToken = String(page.nextPageToken || '')
	} while (pageToken)

	const videoIds = items
		.map(function(item) {
			return item && item.snippet && item.snippet.resourceId ? item.snippet.resourceId.videoId : ''
		})
		.filter(Boolean)

	const videoDetailsMap = await fetchVideoDetails(config, videoIds)
	const tracks = items
		.map(function(item) {
			const videoId = item && item.snippet && item.snippet.resourceId ? item.snippet.resourceId.videoId : ''
			return toTrack(item, videoDetailsMap.get(videoId), config.playlistId)
		})
		.filter(function(track) {
			return Boolean(track && track.id)
		})

	return {
		source: 'youtube',
		playlistId: config.playlistId,
		playlistTitle: config.playlistTitle,
		sections: [
			{
				title: config.playlistTitle,
				tracks: tracks
			}
		]
	}
}

async function main() {
	const defaultConfig = buildDefaultConfig()
	const args = parseArgs(process.argv.slice(2))
	if (args.help) {
		printHelp(defaultConfig)
		return
	}

	const config = {
		apiKey: String(args.apiKey || defaultConfig.apiKey || '').trim(),
		playlistId: String(args.playlistId || defaultConfig.playlistId || '').trim(),
		playlistTitle: String(args.title || defaultConfig.playlistTitle || DEFAULT_PLAYLIST_TITLE_FALLBACK).trim() || DEFAULT_PLAYLIST_TITLE_FALLBACK,
		maxResults: clampMaxResults(args.maxResults),
		outPath: args.outPath ? path.resolve(args.outPath) : defaultConfig.outPath,
		stdout: Boolean(args.stdout)
	}

	if (!config.apiKey || !config.playlistId) {
		console.error(`Missing config. Set apiKey/playlistId in ${LOCAL_CONFIG_LABEL}, set env YOUTUBE_API_KEY / YOUTUBE_PLAYLIST_ID, or pass --api-key / --playlist-id.`)
		process.exitCode = 1
		return
	}

	const result = await fetchPlaylistSongs(config)
	const jsonText = toOutputJson(result)

	if (config.stdout) {
		process.stdout.write(jsonText)
		return
	}

	writeOutput(config.outPath, jsonText)
	console.log('Wrote fetched playlist JSON to:', config.outPath)
	console.log('Tracks:', (result.sections && result.sections[0] && Array.isArray(result.sections[0].tracks)) ? result.sections[0].tracks.length : 0)
}

main().catch(function(error) {
	console.error('Error:', error && error.message ? error.message : error)
	process.exit(1)
})
