#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
	loadFetcherConfig,
	normalizeConfiguredText,
	resolveFetchedSongsJsonPath,
	resolveSongsDirPath,
	resolveToolPath
} from './tool-paths.js'

const FETCHED_JSON_PATH = resolveFetchedSongsJsonPath()
const OUTPUT_DIR = resolveSongsDirPath()
const PYTHON_COMMAND_CANDIDATES = process.platform === 'win32'
	? ['python', 'py', 'python3']
	: ['python3', 'python']
const FETCHER_CONFIG = loadFetcherConfig()
const YTDLP_CONFIG = FETCHER_CONFIG.ytDlp && typeof FETCHER_CONFIG.ytDlp === 'object' && !Array.isArray(FETCHER_CONFIG.ytDlp)
	? FETCHER_CONFIG.ytDlp
	: {}

// Parse command line arguments
const args = process.argv.slice(2)
const maxDownloads = args.length > 0 ? Math.max(1, parseInt(args[0], 10)) : Infinity

function resolveOptionalToolPath(rawValue) {
	const normalized = normalizeConfiguredText(rawValue)
	if (!normalized) return ''
	return path.isAbsolute(normalized) ? normalized : resolveToolPath(normalized)
}

function resolveYtDlpOptions() {
	const jsRuntime = normalizeConfiguredText(process.env.YTDLP_JS_RUNTIME || YTDLP_CONFIG.jsRuntime)
	const jsRuntimePath = resolveOptionalToolPath(process.env.YTDLP_JS_RUNTIME_PATH || YTDLP_CONFIG.jsRuntimePath)
	const cookiesPath = resolveOptionalToolPath(process.env.YTDLP_COOKIES_PATH || YTDLP_CONFIG.cookiesPath)
	const cookiesFromBrowser = normalizeConfiguredText(process.env.YTDLP_COOKIES_FROM_BROWSER || YTDLP_CONFIG.cookiesFromBrowser)
	const extraArgs = Array.isArray(YTDLP_CONFIG.extraArgs)
		? YTDLP_CONFIG.extraArgs.map((value) => String(value || '').trim()).filter(Boolean)
		: []

	return {
		jsRuntime,
		jsRuntimePath,
		cookiesPath,
		cookiesFromBrowser,
		extraArgs
	}
}

function buildYtDlpArgs(outputPath, videoUrl, ytDlpOptions) {
	const runtimeValue = ytDlpOptions.jsRuntime
		? (ytDlpOptions.jsRuntimePath ? `${ytDlpOptions.jsRuntime}:${ytDlpOptions.jsRuntimePath}` : ytDlpOptions.jsRuntime)
		: ''

	if (ytDlpOptions.cookiesPath && !fs.existsSync(ytDlpOptions.cookiesPath)) {
		throw new Error(`Configured yt-dlp cookies file not found: ${ytDlpOptions.cookiesPath}`)
	}

	const commandArgs = [
		'-m',
		'yt_dlp',
		'--no-playlist',
		'-f',
		'bestaudio/best',
		'-x',
		'--audio-format',
		'mp3',
		'--audio-quality',
		'192K',
		'-o',
		outputPath
	]

	if (runtimeValue) {
		commandArgs.push('--js-runtimes', runtimeValue)
	}

	if (ytDlpOptions.cookiesPath) {
		commandArgs.push('--cookies', ytDlpOptions.cookiesPath)
	} else if (ytDlpOptions.cookiesFromBrowser) {
		commandArgs.push('--cookies-from-browser', ytDlpOptions.cookiesFromBrowser)
	}

	if (ytDlpOptions.extraArgs.length > 0) {
		commandArgs.push(...ytDlpOptions.extraArgs)
	}

	commandArgs.push(videoUrl)
	return commandArgs
}

function resolvePythonCommand() {
	const override = String(process.env.YTDLP_PYTHON_BIN || process.env.PYTHON_BIN || '').trim()
	const candidates = override ? [override] : PYTHON_COMMAND_CANDIDATES

	for (const command of candidates) {
		const result = spawnSync(command, ['--version'], {
			stdio: 'pipe',
			shell: false
		})

		if (!result.error && result.status === 0) {
			return command
		}
	}

	throw new Error('Python executable not found. Set YTDLP_PYTHON_BIN to a valid command such as python3.')
}

function ensureYtDlpAvailable(pythonCommand) {
	const result = spawnSync(pythonCommand, ['-m', 'yt_dlp', '--version'], {
		stdio: 'pipe',
		shell: false
	})

	if (!result.error && result.status === 0) {
		return
	}

	throw new Error(`yt-dlp is not available for ${pythonCommand}. Install it with "${pythonCommand} -m pip install yt-dlp" and ensure ffmpeg is installed.`)
}

async function ensureOutputDir() {
	if (!fs.existsSync(OUTPUT_DIR)) {
		fs.mkdirSync(OUTPUT_DIR, { recursive: true })
		console.log(`Created output directory: ${OUTPUT_DIR}`)
	}
}

function loadFetchedPlaylist() {
	if (!fs.existsSync(FETCHED_JSON_PATH)) {
		throw new Error(`Fetched playlist not found at: ${FETCHED_JSON_PATH}`)
	}

	const content = fs.readFileSync(FETCHED_JSON_PATH, 'utf-8')
	const data = JSON.parse(content)

	if (!data.sections || !Array.isArray(data.sections)) {
		throw new Error('Invalid fetched playlist format: missing sections array')
	}

	const tracks = []
	data.sections.forEach(function(section) {
		if (Array.isArray(section.tracks)) {
			tracks.push.apply(tracks, section.tracks)
		}
	})

	return tracks
}

function sanitizeFilename(filename) {
	return filename
		.replace(/[<>:"|?*]/g, '_')
		.replace(/\\/g, '_')
		.replace(/\//g, '_')
		.slice(0, 200)
}

function downloadTrack(track, index, pythonCommand, ytDlpOptions) {
	const videoId = track.youtubeVideoId

	if (!videoId) {
		console.warn(`[${index}] Skipping track "${track.title}" - no YouTube video ID`)
		return false
	}

	const artistSanitized = sanitizeFilename(track.artist || 'Unknown')
	const titleSanitized = sanitizeFilename(track.title || 'Untitled')
	const outputFilename = `${artistSanitized} - ${titleSanitized}.mp3`
	const outputPath = resolveSongsDirPath(outputFilename)

	// Skip if already downloaded
	if (fs.existsSync(outputPath)) {
		console.log(`[${index}] Already exists: ${outputFilename}`)
		return true
	}

	try {
		console.log(`[${index}] Downloading: "${track.title}" by ${track.artist}`)
		const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
		const result = spawnSync(pythonCommand, buildYtDlpArgs(outputPath, videoUrl, ytDlpOptions), {
			stdio: 'inherit',
			shell: false
		})

		if (result.error) {
			throw result.error
		}
		if (result.status !== 0) {
			throw new Error(`yt-dlp exited with code ${result.status}`)
		}
		console.log(`[${index}] ✓ Downloaded: ${outputFilename}`)
		return true
	} catch (error) {
		console.error(`[${index}] ✗ Failed to download: ${track.title}`)
		console.error(`    Error: ${error.message}`)
		return false
	}
}

async function main() {
	try {
		console.log('=== YouTube Playlist MP3 Downloader ===\n')

		const pythonCommand = resolvePythonCommand()
		const ytDlpOptions = resolveYtDlpOptions()
		ensureYtDlpAvailable(pythonCommand)

		await ensureOutputDir()

		const tracks = loadFetchedPlaylist()
		console.log(`Loaded ${tracks.length} tracks from fetched playlist\n`)
		console.log(`Using Python command: ${pythonCommand}\n`)
		if (ytDlpOptions.jsRuntime) {
			const runtimeLabel = ytDlpOptions.jsRuntimePath ? `${ytDlpOptions.jsRuntime} (${ytDlpOptions.jsRuntimePath})` : ytDlpOptions.jsRuntime
			console.log(`Using JS runtime: ${runtimeLabel}`)
		}
		if (ytDlpOptions.cookiesPath) {
			console.log(`Using cookies file: ${ytDlpOptions.cookiesPath}`)
		} else if (ytDlpOptions.cookiesFromBrowser) {
			console.log(`Using cookies from browser: ${ytDlpOptions.cookiesFromBrowser}`)
		}
		if (ytDlpOptions.extraArgs.length > 0) {
			console.log(`Using extra yt-dlp args: ${ytDlpOptions.extraArgs.join(' ')}`)
		}
		if (ytDlpOptions.jsRuntime || ytDlpOptions.cookiesPath || ytDlpOptions.cookiesFromBrowser || ytDlpOptions.extraArgs.length > 0) {
			console.log('')
		}

		if (tracks.length === 0) {
			console.log('No tracks found in playlist.')
			return
		}

		const tracksToDownload = tracks.slice(0, maxDownloads)
		console.log(`Downloading first ${tracksToDownload.length} track(s)...\n`)

		let successCount = 0
		let failureCount = 0

		tracksToDownload.forEach(function(track, index) {
			const success = downloadTrack(track, index + 1, pythonCommand, ytDlpOptions)
			if (success) {
				successCount++
			} else {
				failureCount++
			}
		})

		console.log(`\n=== Download Summary ===`)
		console.log(`Success: ${successCount}`)
		console.log(`Failed: ${failureCount}`)
		console.log(`Output directory: ${OUTPUT_DIR}`)

		if (failureCount > 0) {
			process.exitCode = 1
		}
	} catch (error) {
		console.error('Error:', error.message)
		process.exit(1)
	}
}

main()
