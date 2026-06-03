#!/usr/bin/env node

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolveProfileMusicPath } from './tool-paths.js'

const FETCHED_JSON_PATH = resolveProfileMusicPath('fetched-songs-ytb-api.json')
const OUTPUT_DIR = resolveProfileMusicPath('songs')
const PYTHON_COMMAND_CANDIDATES = process.platform === 'win32'
	? ['python', 'py', 'python3']
	: ['python3', 'python']

// Parse command line arguments
const args = process.argv.slice(2)
const maxDownloads = args.length > 0 ? Math.max(1, parseInt(args[0], 10)) : Infinity

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

function downloadTrack(track, index, pythonCommand) {
	const videoId = track.youtubeVideoId

	if (!videoId) {
		console.warn(`[${index}] Skipping track "${track.title}" - no YouTube video ID`)
		return false
	}

	const artistSanitized = sanitizeFilename(track.artist || 'Unknown')
	const titleSanitized = sanitizeFilename(track.title || 'Untitled')
	const outputFilename = `${artistSanitized} - ${titleSanitized}.mp3`
	const outputPath = resolveProfileMusicPath('songs', outputFilename)

	// Skip if already downloaded
	if (fs.existsSync(outputPath)) {
		console.log(`[${index}] Already exists: ${outputFilename}`)
		return true
	}

	try {
		console.log(`[${index}] Downloading: "${track.title}" by ${track.artist}`)
		const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
		const result = spawnSync(pythonCommand, [
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
			outputPath,
			videoUrl
		], {
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
		ensureYtDlpAvailable(pythonCommand)

		await ensureOutputDir()

		const tracks = loadFetchedPlaylist()
		console.log(`Loaded ${tracks.length} tracks from fetched playlist\n`)
		console.log(`Using Python command: ${pythonCommand}\n`)

		if (tracks.length === 0) {
			console.log('No tracks found in playlist.')
			return
		}

		const tracksToDownload = tracks.slice(0, maxDownloads)
		console.log(`Downloading first ${tracksToDownload.length} track(s)...\n`)

		let successCount = 0
		let failureCount = 0

		tracksToDownload.forEach(function(track, index) {
			const success = downloadTrack(track, index + 1, pythonCommand)
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
	} catch (error) {
		console.error('Error:', error.message)
		process.exit(1)
	}
}

main()
