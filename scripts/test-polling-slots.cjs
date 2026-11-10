const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

const source = readFileSync(require('node:path').join(__dirname, '../src/components/MeetingStage.vue'), 'utf8')
const attachSource = source.slice(source.indexOf('async function attachPollingSlot('), source.indexOf('/** 按当前主持人'))
const clearSource = source.slice(source.indexOf('function clearPollingSlots('), source.indexOf('function refreshMeetingLayoutAfterParticipantChange('))

function setup({ fail = false } = {}) {
  const calls = []
  const slots = ['left', 'right'].map(() => {
    const children = []
    return {
      tagName: 'DIV', children,
      ownerDocument: { createElement: (tag) => ({
        tagName: tag.toUpperCase(), srcObject: null,
        play: () => Promise.resolve(),
        remove() { children.splice(children.indexOf(this), 1) },
      }) },
      appendChild: (element) => children.push(element),
      querySelectorAll: () => [...children],
      querySelector: () => children[0] ?? null,
    }
  })
  const track = {
    attach(element) {
      calls.push(['attach', element])
      assert.equal(element.tagName, 'VIDEO', 'Jitsi attach requires a VIDEO, not a slot DIV')
      assert.equal(element.autoplay, true)
      assert.equal(element.muted, true)
      assert.equal(element.playsInline, true)
      if (fail) return Promise.reject(new Error('track unavailable'))
      element.srcObject = { active: true }
      return Promise.resolve()
    },
    detach(element) { calls.push(['detach', element]); element.srcObject = null },
  }
  const context = vm.createContext({
    pollingLeftSlot: { value: slots[0] }, pollingRightSlot: { value: slots[1] },
    pollingLeftHasVideo: { value: false }, pollingRightHasVideo: { value: false },
    jitsiApi: { value: {} }, localParticipantId: { value: 'host' }, status: { value: 'joined' },
    getParticipantCameraTrack: () => track,
    console: { warn() {} },
  })
  vm.runInContext(ts.transpile(`
    let pollingLeftAttachedId = '', pollingRightAttachedId = '';
    let pollingLeftTrack = null, pollingRightTrack = null;
    ${attachSource}\n${clearSource}
  `), context)
  return { context, slots, calls, track }
}

async function main() {
  const { context, slots, calls } = setup()
  await context.attachPollingSlot('left', 'host')
  await context.attachPollingSlot('right', 'member')
  assert.equal(slots[0].children.length, 1)
  assert.equal(slots[1].children.length, 1)
  assert.equal(context.pollingLeftHasVideo.value, true)
  assert.equal(context.pollingRightHasVideo.value, true)
  await context.attachPollingSlot('right', 'member')
  assert.equal(calls.filter(([kind]) => kind === 'attach').length, 2, 'unchanged slots must not reattach')
  await context.attachPollingSlot('right', 'next-member')
  assert.equal(calls[2][0], 'detach')
  assert.equal(calls[2][1].tagName, 'VIDEO')
  context.clearPollingSlots()
  assert.equal(slots[0].children.length + slots[1].children.length, 0)
  assert.equal(context.pollingLeftHasVideo.value, false)
  assert.equal(context.pollingRightHasVideo.value, false)

  const failed = setup({ fail: true })
  await failed.context.attachPollingSlot('left', 'host')
  assert.equal(failed.context.pollingLeftHasVideo.value, false, 'failed attachment must keep placeholder')
  assert.equal(failed.slots[0].children.length, 0)
  await failed.context.attachPollingSlot('left', 'host')
  assert.equal(failed.calls.filter(([kind]) => kind === 'attach').length, 2, 'failed attachment must be retryable')
  console.log('PASS polling: two video elements, playback attributes, idempotency, switching, cleanup and failure retry')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
