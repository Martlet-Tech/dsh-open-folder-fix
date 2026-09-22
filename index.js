/**
 * Host half of dsh-open-folder-fix.
 *
 * One route, `POST /open-folder-fix/open`, taking `{ path }` and opening that
 * directory with `explorer.exe /e,<dir>`.
 *
 * Why this exists: the shipped `explorer` catalog entry launches through
 * `shell-open`, which on Windows runs
 *   powershell.exe -NoProfile -Command "Invoke-Item -LiteralPath '<dir>'"
 * `Invoke-Item` runs the directory's default shell verb, and that verb REUSES
 * an existing File Explorer window for that directory instead of raising a
 * window. It also returns 0 as soon as the shell accepts the handoff, so the
 * host reports success even when nothing became visible — which is why the
 * shipped button can appear to do nothing, or to disturb the window the user
 * already had open.
 *
 * `explorer.exe /e,<dir>` raises a window for the directory in both cases
 * (measured 6/6 fresh windows, and again with the directory already open).
 *
 * The route path is deliberately NOT one of the shipped `/open-in-app/*`
 * paths: `webServer.register` rejects a duplicate (kind, path), so overriding
 * the shipped route would throw at load. Every other application in the menu
 * keeps the shipped `/open-in-app/open`, and the browser half routes only the
 * file-manager id here.
 *
 * Nothing in this file imports `@deepseek-ai/dsh-host-open-in-app`: that
 * package exports only `Config`, `apply`, `inject`, and `name`, so its catalog
 * resolution is not reachable from a sibling plugin. Staying on the public
 * HTTP surface is what keeps this fix independent of an alpha-version
 * internal.
 */

import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { platform } from 'node:os'

/** Cordis function-plugin name. */
export const name = 'open-folder-fix'

/** The route carrier and the trust fence guarding the route. */
export const inject = ['webServer', 'connection']

/**
 * Early-failure watch window for the explorer.exe handoff. Explorer exits as
 * soon as it has asked the running shell to raise the window, so launch
 * success is decoupled from process exit and this window only bounds the wait.
 */
const LAUNCH_WATCH_MS = 1500

/**
 * Plugin configuration, as a Standard Schema validator.
 *
 * Cordis validates the loader entry's `config` against this export, and it
 * does so by reading `Config['~standard'].validate` (see `resolveConfig` in
 * `@deepseek-ai/cordis`). A plain object is truthy but has no `~standard`, so
 * it makes that read throw and takes the whole plugin tree down at boot.
 *
 * The bounds are wide on purpose: this is an early-failure watch window, not
 * a timeout that cancels the launch.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-open-folder-fix',
    /**
     * Validate and default one deployment configuration.
     * @param value - the raw loader-entry config; absent means "all defaults".
     * @returns the resolved config, or the issues that reject it.
     */
    validate(value) {
      const input = value ?? {}
      if (typeof input !== 'object') {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const launchWatchMs = input.launchWatchMs ?? LAUNCH_WATCH_MS
      if (!Number.isInteger(launchWatchMs) || launchWatchMs < 1 || launchWatchMs > 600000) {
        return {
          issues: [{
            message: 'must be an integer between 1 and 600000',
            path: ['launchWatchMs'],
          }],
        }
      }
      return { value: { ...input, launchWatchMs } }
    },
  },
}

/** POST route opening one directory in File Explorer. */
const OPEN_FOLDER_ROUTE = '/open-folder-fix/open'

/** Open-route request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** The composition's connection service (its package is browser-side). */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/** JSON response; the launch outcome is a live fact, never a cached body. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Validate one request body: a JSON object with a string path. */
function parseOpenBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  return typeof body.path === 'string' ? { path: body.path } : null
}

/** Probe one path as an existing directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Spawn one detached launcher: no stdio pipe, outliving this process, with the
 * GUI child left visible. A launcher still running when the watch window
 * closes counts as launched and is never killed.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param watchMs - early-failure watch window.
 * @returns whether a spawn failure was proven inside the window.
 */
function launchDetached(command, args, watchMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(command, [...args], { windowsHide: false })
    } catch (error) {
      resolve({ ok: false, error })
      return
    }
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      child.removeAllListeners()
      child.unref()
      resolve(outcome)
    }
    // Explorer's own exit status proves nothing: it hands the request to the
    // running shell and exits. Only ENOENT (and a spawn error) is a failure.
    const watch = setTimeout(() => settle({ ok: true }), watchMs)
    child.on('error', (error) => settle({ ok: false, error }))
    child.on('exit', () => settle({ ok: true }))
  })
}

/**
 * Register the workspace-open fix.
 * @param ctx - composition context carrying webServer and connection.
 * @param config - deployment configuration; `launchWatchMs` overrides the default.
 */
export function apply(ctx, config) {
  const watchMs = typeof config?.launchWatchMs === 'number' ? config.launchWatchMs : LAUNCH_WATCH_MS
  const windows = platform() === 'win32'

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_FOLDER_ROUTE,
    handler: async (req, res) => {
      const rejection = connectionOf(ctx).requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text
      try {
        text = await readBoundedBody(req)
      } catch {
        sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const parsed = parseOpenBody(text)
      if (parsed === null) {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON with a string "path"' })
        return
      }
      if (parsed.path === '' || !isAbsolute(parsed.path)) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute directory path' })
        return
      }
      if (!await isDirectory(parsed.path)) {
        sendJson(res, 404, { code: 'not-found', message: `directory does not exist: ${parsed.path}` })
        return
      }
      if (!windows) {
        sendJson(res, 501, { code: 'unsupported-platform', message: 'the explorer.exe opener is Windows-only' })
        return
      }
      const { ok, error } = await launchDetached('explorer.exe', ['/e,', parsed.path], watchMs)
      if (ok) {
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 502, {
        code: 'launch-failed',
        message: `failed to launch explorer.exe: ${error instanceof Error ? error.message : String(error)}`,
      })
    },
  }), `open-folder-fix: POST ${OPEN_FOLDER_ROUTE}`)
}

export { OPEN_FOLDER_ROUTE }
