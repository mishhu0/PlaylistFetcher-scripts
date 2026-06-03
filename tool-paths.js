import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT_DIR = path.join(TOOL_DIR, '..')
const FETCHER_CONFIG_PATH = path.join(TOOL_DIR, 'music-song-fetcher.config.local.json')
const CONFIG_PLACEHOLDER_PATTERN = /^(?:put(?:_|\s)+your|your\s+.+\s+here|example(?:\s|$))/i

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath)
    return true
  } catch {
    return false
  }
}

function resolveConfiguredPath(targetPath) {
  const value = String(targetPath || '').trim()
  if (!value) return ''
  return path.isAbsolute(value) ? value : path.resolve(WORKSPACE_ROOT_DIR, value)
}

function resolveConfigPath(targetPath) {
  const value = normalizeConfiguredText(targetPath)
  if (!value) return ''
  return path.isAbsolute(value) ? value : path.resolve(TOOL_DIR, value)
}

function normalizeConfiguredText(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return CONFIG_PLACEHOLDER_PATTERN.test(text) ? '' : text
}

function loadFetcherConfig() {
  if (!pathExists(FETCHER_CONFIG_PATH)) {
    return {}
  }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(FETCHER_CONFIG_PATH, 'utf-8'))
  } catch (error) {
    throw new Error(`Invalid JSON in ${getToolRelativePath('music-song-fetcher.config.local.json')}: ${error && error.message ? error.message : error}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config in ${getToolRelativePath('music-song-fetcher.config.local.json')}: expected a JSON object.`)
  }

  return parsed
}

const FETCHER_CONFIG = loadFetcherConfig()
const FETCHER_PATHS = FETCHER_CONFIG.paths && typeof FETCHER_CONFIG.paths === 'object' && !Array.isArray(FETCHER_CONFIG.paths)
  ? FETCHER_CONFIG.paths
  : {}

function getConfiguredPathValue(...keys) {
  for (const key of keys) {
    if (!key) continue
    const resolved = resolveConfigPath(FETCHER_PATHS[key])
    if (resolved) return resolved
  }

  return ''
}

function detectProfileRootDir() {
  const overridePath = resolveConfiguredPath(process.env.PROFILE_SITE_DIR || process.env.PROFILE_ROOT_DIR)
  if (overridePath) return overridePath

  const configuredProfileRoot = getConfiguredPathValue('profileSiteDir', 'profileRootDir')
  if (configuredProfileRoot) return configuredProfileRoot

  const configuredMusicDir = getConfiguredPathValue('profileMusicDir')
  if (configuredMusicDir) return path.dirname(configuredMusicDir)

  const candidates = [
    path.join(WORKSPACE_ROOT_DIR, 'profile'),
    WORKSPACE_ROOT_DIR
  ]

  for (const candidate of candidates) {
    if (pathExists(path.join(candidate, 'music'))) {
      return candidate
    }
  }

  return path.join(WORKSPACE_ROOT_DIR, 'profile')
}

const PROFILE_ROOT_DIR = detectProfileRootDir()
const PROFILE_MUSIC_DIR = getConfiguredPathValue('profileMusicDir') || path.join(PROFILE_ROOT_DIR, 'music')

function normalizeCliPath(filePath) {
  return String(filePath || '').split(path.sep).join('/')
}

function formatCliArgument(filePath) {
  const normalizedPath = normalizeCliPath(filePath)
  return normalizedPath.includes(' ') ? `"${normalizedPath}"` : normalizedPath
}

function resolveRootPath(...segments) {
  return path.join(WORKSPACE_ROOT_DIR, ...segments)
}

function resolveToolPath(...segments) {
  return path.join(TOOL_DIR, ...segments)
}

function resolveProfilePath(...segments) {
  return path.join(PROFILE_ROOT_DIR, ...segments)
}

function resolveProfileMusicPath(...segments) {
  return path.join(PROFILE_MUSIC_DIR, ...segments)
}

function resolveFetchedSongsJsonPath() {
  return getConfiguredPathValue('fetchedJsonPath') || resolveProfileMusicPath('fetched-songs-ytb-api.json')
}

function resolveSongsDirPath(...segments) {
  const songsDir = getConfiguredPathValue('songsDir') || resolveProfileMusicPath('songs')
  return path.join(songsDir, ...segments)
}

function resolveSongsLibraryPath() {
  return getConfiguredPathValue('songsLibraryPath') || resolveProfileMusicPath('songs-library.json')
}

function resolveGenreLibraryPath() {
  return getConfiguredPathValue('genreLibraryPath') || resolveProfileMusicPath('genre-library.json')
}

function getNodeScriptUsage(moduleUrl) {
  const scriptPath = fileURLToPath(moduleUrl)
  const relativePath = path.relative(process.cwd(), scriptPath) || path.basename(scriptPath)
  return 'node ' + formatCliArgument(relativePath)
}

function getToolRelativePath(...segments) {
  return normalizeCliPath(path.join(path.basename(TOOL_DIR), ...segments))
}

export {
  loadFetcherConfig,
  getNodeScriptUsage,
  getToolRelativePath,
  normalizeConfiguredText,
  resolveFetchedSongsJsonPath,
  resolveGenreLibraryPath,
  resolveProfileMusicPath,
  resolveProfilePath,
  resolveRootPath,
  resolveSongsDirPath,
  resolveSongsLibraryPath,
  resolveToolPath
}