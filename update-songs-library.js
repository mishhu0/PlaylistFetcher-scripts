#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import {
	getToolRelativePath,
	resolveFetchedSongsJsonPath,
	resolveSongsDirPath,
	resolveSongsLibraryPath,
	resolveToolPath
} from './tool-paths.js'

const SONGS_DIR = resolveSongsDirPath()
const SONGS_LIBRARY_PATH = resolveSongsLibraryPath()

const FETCHED_YT_PRIMARY_PATH = resolveFetchedSongsJsonPath()
const FETCHED_YT_FALLBACK_PATH = resolveToolPath('fetched-songs-ytb-api.json')

const GENRE_TODO_PATH = resolveToolPath('genre-todo.json')

function readJson(filePath) {
	const content = fs.readFileSync(filePath, 'utf-8')
	return JSON.parse(content)
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

function sanitizeFilename(value) {
	return String(value || '')
		.replace(/[<>:"|?*]/g, '_')
		.replace(/\\/g, '_')
		.replace(/\//g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200)
}

function slugify(value) {
	return String(value || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80)
}

function cleanYouTubeArtist(artist) {
	return String(artist || '').replace(/\s*-\s*topic\s*$/i, '').trim() || String(artist || '').trim()
}

function normalizeKey(value) {
	return String(value || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '')
}

function toPosixMusicSongsPath(basename) {
	return path.posix.join('music', 'songs', basename)
}

function getBasenameFromTrackFile(trackFile) {
	if (!trackFile) return ''
	return path.posix.basename(String(trackFile))
}

function listMp3Basenames(dirPath) {
	if (!fileExists(dirPath)) return []

	return fs
		.readdirSync(dirPath)
		.filter((name) => name.toLowerCase().endsWith('.mp3'))
}

function flattenFetchedTracks(fetchedJson) {
	const sections = Array.isArray(fetchedJson && fetchedJson.sections) ? fetchedJson.sections : []
	const tracks = []
	for (const section of sections) {
		const sectionTracks = Array.isArray(section && section.tracks) ? section.tracks : []
		tracks.push(...sectionTracks)
	}
	return tracks
}

function buildFetchedIndexes(fetchedTracks) {
	const byExpectedBasename = new Map()
	const byArtistTitleKey = new Map()
	const byTitleKey = new Map()

	for (const track of fetchedTracks) {
		const rawTitle = String(track && track.title ? track.title : '')
		const rawArtist = String(track && track.artist ? track.artist : '')
		if (!rawTitle) continue

		const cleanedArtist = cleanYouTubeArtist(rawArtist)
		const titleKey = normalizeKey(rawTitle)
		const artistKey = normalizeKey(cleanedArtist)
		const artistTitleKey = artistKey + '||' + titleKey

		const expectedBasename = sanitizeFilename(`${rawArtist} - ${rawTitle}`) + '.mp3'
		if (expectedBasename.trim() !== '.mp3') {
			byExpectedBasename.set(expectedBasename, {
				raw: track,
				title: rawTitle,
				artist: cleanedArtist
			})
		}

		if (!byArtistTitleKey.has(artistTitleKey)) {
			byArtistTitleKey.set(artistTitleKey, {
				raw: track,
				title: rawTitle,
				artist: cleanedArtist
			})
		}

		if (titleKey) {
			const list = byTitleKey.get(titleKey) || []
			list.push({
				raw: track,
				title: rawTitle,
				artist: cleanedArtist
			})
			byTitleKey.set(titleKey, list)
		}
	}

	return { byExpectedBasename, byArtistTitleKey, byTitleKey }
}

function pickFetchedMatchForLibraryTrack(track, indexes) {
	const title = String(track && track.title ? track.title : '')
	const artist = String(track && track.artist ? track.artist : '')
	const titleKey = normalizeKey(title)
	const artistKey = normalizeKey(artist)

	if (titleKey && artistKey) {
		const direct = indexes.byArtistTitleKey.get(artistKey + '||' + titleKey)
		if (direct) return direct
	}

	if (titleKey) {
		const byTitle = indexes.byTitleKey.get(titleKey) || []
		if (byTitle.length === 1) return byTitle[0]
	}

	return null
}

function inferArtistTitleFromBasename(basename) {
	const baseNoExt = basename.replace(/\.mp3$/i, '')
	const parts = baseNoExt.split(' - ').map((p) => p.trim()).filter(Boolean)
	if (parts.length >= 2) {
		return {
			artist: parts[0],
			title: parts.slice(1).join(' - ')
		}
	}

	return { artist: 'Unknown', title: baseNoExt }
}

function ensureUniqueId(candidate, usedIds) {
	let id = candidate
	if (!id) id = 'track'
	if (!usedIds.has(id)) {
		usedIds.add(id)
		return id
	}

	let suffix = 2
	while (usedIds.has(`${id}-${suffix}`)) suffix++
	const next = `${id}-${suffix}`
	usedIds.add(next)
	return next
}

function ensureFirstSection(library) {
	if (!library || !Array.isArray(library.sections)) {
		library.sections = []
	}

	if (library.sections.length === 0) {
		library.sections.push({
			title: 'MY TOP SONGS ATM',
			tracks: []
		})
	}

	const firstSection = library.sections[0]
	if (!firstSection || !Array.isArray(firstSection.tracks)) {
		library.sections[0] = Object.assign({}, firstSection || {}, { tracks: Array.isArray(firstSection && firstSection.tracks) ? firstSection.tracks : [] })
	}

	return library.sections[0]
}

function findSectionByTitle(library, title) {
	const sections = Array.isArray(library && library.sections) ? library.sections : []
	const matchTitle = String(title || '').trim().toLowerCase()
	return sections.find((section) => String(section && section.title || '').trim().toLowerCase() === matchTitle) || null
}

function main() {
	if (!fileExists(SONGS_LIBRARY_PATH)) {
		throw new Error(`Missing: ${SONGS_LIBRARY_PATH}`)
	}
	if (!fileExists(SONGS_DIR)) {
		throw new Error(`Missing folder: ${SONGS_DIR}`)
	}

	const fetchedPath = fileExists(FETCHED_YT_PRIMARY_PATH)
		? FETCHED_YT_PRIMARY_PATH
		: (fileExists(FETCHED_YT_FALLBACK_PATH) ? FETCHED_YT_FALLBACK_PATH : '')

	if (!fetchedPath) {
		throw new Error(`Missing fetched YouTube JSON. Expected music/fetched-songs-ytb-api.json (or ${getToolRelativePath('fetched-songs-ytb-api.json')}).`)
	}

	const library = readJson(SONGS_LIBRARY_PATH)
	const fetched = readJson(fetchedPath)

	const sections = Array.isArray(library.sections) ? library.sections : []
	const coolSongsSection = findSectionByTitle(library, 'COOL SONGS') || ensureFirstSection(library)
	const fetchedTracks = flattenFetchedTracks(fetched)
	const indexes = buildFetchedIndexes(fetchedTracks)
	const fetchedExpectedBasenames = new Set(indexes.byExpectedBasename.keys())

	const availableBasenames = new Set(listMp3Basenames(SONGS_DIR))

	const usedBasenames = new Set()
	const usedIds = new Set()
	let updatedMetadataCount = 0
	let updatedFilePathCount = 0
	let removedNotInPlaylistCount = 0

	for (const section of sections) {
		const tracks = Array.isArray(section && section.tracks) ? section.tracks : []
		const keptTracks = []
		for (const track of tracks) {
			let basename = getBasenameFromTrackFile(track && track.file ? track.file : '')
			const fetchedMatch = pickFetchedMatchForLibraryTrack(track, indexes)
			const fetchedByName = (!fetchedMatch && basename && indexes.byExpectedBasename.has(basename))
				? indexes.byExpectedBasename.get(basename)
				: null

			const isInPlaylist = Boolean(fetchedMatch || fetchedByName)
			if (!isInPlaylist) {
				removedNotInPlaylistCount++
				continue
			}

			if (track && track.id) usedIds.add(String(track.id))

			if (fetchedMatch) {
				const nextTitle = fetchedMatch.title
				const nextArtist = fetchedMatch.artist
				if (track.title !== nextTitle || track.artist !== nextArtist) {
					track.title = nextTitle
					track.artist = nextArtist
					updatedMetadataCount++
				}

				const expectedBasename = sanitizeFilename(`${String(fetchedMatch.raw.artist || '')} - ${String(fetchedMatch.raw.title || '')}`) + '.mp3'
				if (availableBasenames.has(expectedBasename)) {
					basename = expectedBasename
				}
			} else if (fetchedByName) {
				const nextTitle = fetchedByName.title
				const nextArtist = fetchedByName.artist
				if (track.title !== nextTitle || track.artist !== nextArtist) {
					track.title = nextTitle
					track.artist = nextArtist
					updatedMetadataCount++
				}
			}

			if (basename && availableBasenames.has(basename)) {
				const nextFile = toPosixMusicSongsPath(basename)
				if (track.file !== nextFile) {
					track.file = nextFile
					updatedFilePathCount++
				}
				track.downloadable = true
				usedBasenames.add(basename)
			} else {
				track.downloadable = false
				if (basename) usedBasenames.add(basename)
			}

			if (!track.genre) track.genre = 'Unknown'
			keptTracks.push(track)
		}
		section.tracks = keptTracks
	}

	const newlyAddedTracks = []
	for (const basename of availableBasenames) {
		if (!fetchedExpectedBasenames.has(basename)) continue
		if (usedBasenames.has(basename)) continue

		const fetchedByName = indexes.byExpectedBasename.get(basename) || null
		const inferred = inferArtistTitleFromBasename(basename)

		const title = fetchedByName ? fetchedByName.title : inferred.title
		const artist = fetchedByName ? fetchedByName.artist : inferred.artist

		const idCandidate = slugify(`${artist}-${title}`) || slugify(title) || slugify(basename)
		const id = ensureUniqueId(idCandidate, usedIds)

		newlyAddedTracks.push({
			id,
			title,
			artist,
			genre: 'Unknown',
			file: toPosixMusicSongsPath(basename),
			downloadable: true
		})
	}

	newlyAddedTracks.sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title))

	if (newlyAddedTracks.length > 0) {
		coolSongsSection.tracks.push(...newlyAddedTracks)
	}

	writeJson(SONGS_LIBRARY_PATH, library)

	const genreTodo = []
	for (const section of library.sections) {
		const tracks = Array.isArray(section && section.tracks) ? section.tracks : []
		for (const track of tracks) {
			const genre = String(track.genre || '').trim()
			if (genre && genre.toLowerCase() !== 'unknown') continue

			const title = String(track.title || '').trim()
			const artist = String(track.artist || '').trim()
			const query = [artist, title, 'genre'].filter(Boolean).join(' ')
			genreTodo.push({
				artist,
				title,
				file: track.file || '',
				searchUrl: 'https://www.google.com/search?q=' + encodeURIComponent(query)
			})
		}
	}

	writeJson(GENRE_TODO_PATH, { generatedAt: new Date().toISOString(), items: genreTodo })

	console.log('Updated songs library written to:', SONGS_LIBRARY_PATH)
	console.log('Genre todo written to:', GENRE_TODO_PATH)
	console.log('---')
	console.log('Fetched tracks used for metadata:', fetchedTracks.length)
	console.log('Removed (not in playlist):', removedNotInPlaylistCount)
	console.log('Newly added tracks:', newlyAddedTracks.length)
	console.log('Updated title/artist count:', updatedMetadataCount)
	console.log('Updated file path count:', updatedFilePathCount)
	console.log('Tracks needing genre review:', genreTodo.length)
}

try {
	main()
} catch (error) {
	console.error('Error:', error && error.message ? error.message : error)
	process.exit(1)
}
