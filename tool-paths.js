import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT_DIR = path.join(TOOL_DIR, '..')

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

function detectProfileRootDir() {
  const overridePath = resolveConfiguredPath(process.env.PROFILE_SITE_DIR || process.env.PROFILE_ROOT_DIR)
  if (overridePath) return overridePath

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
  return resolveProfilePath('music', ...segments)
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
  getNodeScriptUsage,
  getToolRelativePath,
  resolveProfileMusicPath,
  resolveProfilePath,
  resolveRootPath,
  resolveToolPath
}