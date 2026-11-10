import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const root = process.env.WEB_TEST_ROOT || fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(`${root}/package.json`)
const ts = require('typescript')
const source = readFileSync(`${root}/src/utils/videoPictureRect.ts`, 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: module.exports, module })
const { calculateVideoPictureRect, getMeetingBannerAnchorRect } = module.exports
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })
const equalRect = (actual, expected) => assert.deepEqual({ ...actual }, expected)

test('portrait screenshot: the 16:9 picture starts below the top empty space', () => {
  equalRect(calculateVideoPictureRect(rect(0, 0, 1080, 2376), 1920, 1080, 'contain'), rect(0, 884.25, 1080, 607.5))
})

test('landscape with matching aspect ratio keeps the original bounds', () => {
  equalRect(calculateVideoPictureRect(rect(0, 0, 1280, 720), 1920, 1080, 'contain'), rect(0, 0, 1280, 720))
})

test('wide landscape excludes left and right empty space', () => {
  equalRect(calculateVideoPictureRect(rect(0, 0, 792, 360), 1920, 1080, 'contain'), rect(76, 0, 640, 360))
})

test('positioned tiles and object-position retain viewport coordinates', () => {
  equalRect(calculateVideoPictureRect(rect(20, 60, 400, 400), 1600, 900, 'contain', '50% 100%'), rect(20, 235, 400, 225))
  equalRect(calculateVideoPictureRect(rect(20, 60, 400, 400), 1600, 900, 'contain', '50% 10px'), rect(20, 70, 400, 225))
})

test('cover and fill keep the full element area while scale-down does not enlarge video', () => {
  const box = rect(0, 0, 400, 400)
  equalRect(calculateVideoPictureRect(box, 1600, 900, 'cover'), box)
  equalRect(calculateVideoPictureRect(box, 1600, 900, 'fill'), box)
  equalRect(calculateVideoPictureRect(box, 100, 50, 'scale-down'), rect(150, 175, 100, 50))
})

function fixture() {
  const tile = {
    tagName: 'DIV', parentElement: null, bounds: rect(0, 0, 360, 792),
    getBoundingClientRect() { return this.bounds },
    ownerDocument: { defaultView: { getComputedStyle: node => ({
      display: 'block', visibility: 'visible', opacity: '1', objectFit: 'contain', objectPosition: '50% 50%', ...node.style,
    }) } },
    videos: [], primary: null,
    querySelector() { return this.primary }, querySelectorAll() { return this.videos },
  }
  const addVideo = (options = {}) => {
    const video = {
      tagName: 'VIDEO', videoWidth: 1920, videoHeight: 1080, parentElement: tile,
      getBoundingClientRect: () => tile.bounds, closest: () => null, style: {}, ...options,
    }
    tile.videos.push(video)
    return video
  }
  return { tile, addVideo }
}

test('foreground video wins over the full-size blurred backdrop', () => {
  const { tile, addVideo } = fixture()
  addVideo({ closest: () => ({ id: 'largeVideoBackgroundContainer' }), style: { objectFit: 'cover' } })
  tile.primary = addVideo()
  equalRect(getMeetingBannerAnchorRect(tile), rect(0, 294.75, 360, 202.5))
  tile.primary = null
  equalRect(getMeetingBannerAnchorRect(tile), rect(0, 294.75, 360, 202.5))
})

test('camera off or missing metadata falls back to the existing tile anchor', () => {
  const { tile, addVideo } = fixture()
  equalRect(getMeetingBannerAnchorRect(tile), tile.bounds)
  tile.primary = addVideo({ videoWidth: 0, videoHeight: 0 })
  equalRect(getMeetingBannerAnchorRect(tile), tile.bounds)
  tile.primary.videoWidth = 1920
  tile.primary.videoHeight = 1080
  tile.primary.parentElement = { style: { display: 'none' }, parentElement: tile }
  equalRect(getMeetingBannerAnchorRect(tile), tile.bounds)
})

test('foreground picture is clipped to its participant tile', () => {
  const { tile, addVideo } = fixture()
  tile.bounds = rect(100, 100, 200, 100)
  tile.primary = addVideo({ getBoundingClientRect: () => rect(0, 0, 1000, 1000), style: { objectFit: 'cover' } })
  equalRect(getMeetingBannerAnchorRect(tile), tile.bounds)
})

test('rotation recalculates the picture from the current video element bounds', () => {
  const { tile, addVideo } = fixture()
  tile.primary = addVideo()
  equalRect(getMeetingBannerAnchorRect(tile), rect(0, 294.75, 360, 202.5))
  tile.bounds = rect(0, 0, 792, 360)
  equalRect(getMeetingBannerAnchorRect(tile), rect(76, 0, 640, 360))
})