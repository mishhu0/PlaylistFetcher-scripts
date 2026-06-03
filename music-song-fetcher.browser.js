(() => {
	const fetchState = {
		data: null,
		error: null,
		ready: Promise.resolve(null),
		json: ''
	}

	const DEFAULT_CONFIG = {
		apiKey: window.YOUTUBE_API_KEY || '',
		playlistId: window.YOUTUBE_PLAYLIST_ID || 'PLMesbUqWAwDTx3oi0sdKM6Ro0c6V23W2Y',
		playlistTitle: window.YOUTUBE_PLAYLIST_TITLE || 'YouTube Playlist',
		maxResults: 50
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

	function normalizeConfig(overrides) {
		const merged = Object.assign({}, DEFAULT_CONFIG, window.YOUTUBE_SONGS_FETCHER_CONFIG || {}, overrides || {})

		return {
			apiKey: String(merged.apiKey || '').trim(),
			playlistId: String(merged.playlistId || '').trim(),
			playlistTitle: String(merged.playlistTitle || 'YouTube Playlist').trim() || 'YouTube Playlist',
			maxResults: clampMaxResults(merged.maxResults),
			outputFileName: String(merged.outputFileName || 'fetched-songs-ytb-api.json').trim() || 'fetched-songs-ytb-api.json'
		}
	}

	function toOutputJson(result) {
		return JSON.stringify(result, null, 2)
	}

	async function persistOutput(result, config) {
		const jsonText = toOutputJson(result)
		fetchState.json = jsonText

		const fileHandle = window.YOUTUBE_SONGS_FETCHER_CONFIG && window.YOUTUBE_SONGS_FETCHER_CONFIG.outputFileHandle
		if (fileHandle && typeof fileHandle.createWritable === 'function') {
			const writable = await fileHandle.createWritable()
			try {
				await writable.write(jsonText)
			} finally {
				await writable.close()
			}
			return jsonText
		}

		if (typeof window.YOUTUBE_SONGS_FETCHER_OUTPUT_WRITER === 'function') {
			await Promise.resolve(window.YOUTUBE_SONGS_FETCHER_OUTPUT_WRITER(jsonText, result, config))
			return jsonText
		}

		if (window.YOUTUBE_SONGS_FETCHER_DOWNLOAD_ON_FETCH) {
			const blob = new Blob([jsonText], { type: 'application/json' })
			const url = URL.createObjectURL(blob)
			const anchor = document.createElement('a')
			anchor.href = url
			anchor.download = config.outputFileName
			anchor.style.display = 'none'
			document.body.appendChild(anchor)
			anchor.click()
			anchor.remove()
			setTimeout(function() {
				URL.revokeObjectURL(url)
			}, 0)
			return jsonText
		}

		return jsonText
	}

	async function fetchJson(url) {
		const response = await fetch(url, { cache: 'no-store' })
		if (!response.ok) {
			throw new Error('Request failed: ' + response.status + ' ' + response.statusText)
		}

		return response.json()
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

		return fetchJson(url.toString())
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

			const response = await fetchJson(url.toString())
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

	async function fetchPlaylistSongs(overrides) {
		const config = normalizeConfig(overrides)

		if (!config.apiKey || !config.playlistId) {
			console.warn('YouTube songs fetcher needs YOUTUBE_API_KEY and YOUTUBE_PLAYLIST_ID')
			const emptyResult = {
				source: 'youtube',
				playlistId: config.playlistId,
				playlistTitle: config.playlistTitle,
				sections: [
					{
						title: config.playlistTitle,
						tracks: []
					}
				]
			}
			await persistOutput(emptyResult, config)
			return emptyResult
		}

		const items = []
		let pageToken = ''

		do {
			const page = await fetchPlaylistPage(config, pageToken)
			const pageItems = Array.isArray(page.items) ? page.items : []
			items.push.apply(items, pageItems)
			pageToken = String(page.nextPageToken || '')
		} while (pageToken)

		const videoIds = items.map(function(item) {
			return item && item.snippet && item.snippet.resourceId ? item.snippet.resourceId.videoId : ''
		}).filter(Boolean)

		const videoDetailsMap = await fetchVideoDetails(config, videoIds)
		const tracks = items.map(function(item) {
			const videoId = item && item.snippet && item.snippet.resourceId ? item.snippet.resourceId.videoId : ''
			return toTrack(item, videoDetailsMap.get(videoId), config.playlistId)
		}).filter(function(track) {
			return Boolean(track && track.id)
		})

		const result = {
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

		await persistOutput(result, config)
		return result
	}

	function startAutoFetch(overrides) {
		fetchState.ready = fetchPlaylistSongs(overrides)
			.then(function(result) {
				fetchState.data = result
				fetchState.error = null
				fetchState.json = toOutputJson(result)
				return result
			})
			.catch(function(error) {
				fetchState.error = error
				throw error
			})

		return fetchState.ready
	}

	function shouldAutoFetchOnLoad() {
		if (window.YOUTUBE_SONGS_FETCHER_AUTO_LOAD === true) {
			return true
		}

		return Boolean(window.YOUTUBE_SONGS_FETCHER_CONFIG && window.YOUTUBE_SONGS_FETCHER_CONFIG.autoLoad === true)
	}

	window.YOUTUBE_SONGS_FETCHER_CONFIG = window.YOUTUBE_SONGS_FETCHER_CONFIG || {}
	window.fetchYouTubePlaylistSongs = fetchPlaylistSongs
	window.youtubeSongsFetcher = {
		state: fetchState,
		fetchPlaylistSongs: fetchPlaylistSongs,
		load: startAutoFetch,
		async connectOutputFile() {
			if (!window.showSaveFilePicker) {
				window.YOUTUBE_SONGS_FETCHER_DOWNLOAD_ON_FETCH = true
				return {
					mode: 'download',
					fileName: (window.YOUTUBE_SONGS_FETCHER_CONFIG && window.YOUTUBE_SONGS_FETCHER_CONFIG.outputFileName) || 'fetched-songs-ytb-api.json'
				}
			}

			const handle = await window.showSaveFilePicker({
				suggestedName: (window.YOUTUBE_SONGS_FETCHER_CONFIG && window.YOUTUBE_SONGS_FETCHER_CONFIG.outputFileName) || 'fetched-songs-ytb-api.json',
				types: [
					{
						description: 'JSON file',
						accept: { 'application/json': ['.json'] }
					}
				]
			})

			window.YOUTUBE_SONGS_FETCHER_CONFIG.outputFileHandle = handle
			window.YOUTUBE_SONGS_FETCHER_DOWNLOAD_ON_FETCH = false
			return handle
		},
		async saveNow() {
			if (!fetchState.data) {
				return null
			}

			return persistOutput(fetchState.data, normalizeConfig())
		},
		get ready() {
			return fetchState.ready
		},
		get data() {
			return fetchState.data
		},
		get json() {
			return fetchState.json
		},
		get error() {
			return fetchState.error
		},
		formatDuration: formatDuration
	}

	if (shouldAutoFetchOnLoad()) {
		if (window.document && document.readyState !== 'loading') {
			startAutoFetch()
		} else if (window.document) {
			document.addEventListener('DOMContentLoaded', function() {
				startAutoFetch()
			}, { once: true })
		}
	}
})()
