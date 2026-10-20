import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { LiveOutputServer } from '../electron/main/services/LiveOutputServer.ts'

// Real Chromium tests the same Browser Source HTML, image decode, and WAV audio
// playback acknowledgment used by OBS. It does not claim real OBS/RTMP output.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nhBcAAAAASUVORK5CYII=',
  'base64',
)

// Small real VP8 WebM generated with FFmpeg for cross-platform Chromium playback.
const WEBM = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAL+EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggLo7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDNXQYxMYXZmNjEuNy4xMDNEiYhAksAAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIOPxtc7xYCSCcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4JCwgSC6gSCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjcuMTAzc3PWY8CLY8WIOPxtc7xYCSBnyKFFo4dFTkNPREVSRIeUTGF2YzYxLjE5LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjIwMDAwMDAwMAAfQ7Z1QT/ngQCjvYEAAIDQAgCdASogACAAAEcIhYWIhYSIAgICdaoD+AIIIQg9AP7/TRL//FhX8WFfxYV/8WFf/PzO7cX85gCjlYEAZACxAQABEBAAGAAYWC/0AAhwAKOVgQDIALEBAAEQEAAYABhYL/QACHAAo5WBASwAsQEAARAQABgAGFgv9AAIcACjlYEBkACxAQABEBAAGAAYWC/0AAhwAKOVgQH0ALEBAAEQEAAYABhYL/QACHAAo5WBAlgAsQEAARAQABgAGFgv9AAIcACjlYECvACxAQABEBAUYABhYL/QACHAAKOVgQMgALEBAAEQEAAYABhYL/QACHAAo5WBA4QAsQEAARAQABgAGFgv9AAIcACjlYED6ACxAQABEBAAGAAYWC/0AAhwAKOVgQRMALEBAAEQEAAYABhYL/QACHAAHFO7a5G7j7OBALeK94EB8YIBo/CBAw==', 'base64')

function toneWav(seconds = 0.4, sampleRate = 24000) {
  const count = Math.floor(seconds * sampleRate)
  const buffer = Buffer.alloc(44 + count * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)  // PCM
  buffer.writeUInt16LE(1, 22)  // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(count * 2, 40)
  for (let i = 0; i < count; i++) {
    const fade = Math.min(1, i / 500, (count - i) / 500)
    buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 4000 * fade), 44 + 2 * i)
  }
  return buffer.toString('base64')
}

const dir = mkdtempSync(join(tmpdir(), 'live-output-browser-'))
const picture = join(dir, 'test-product.png')
const movie = join(dir, 'test-product.webm')
writeFileSync(picture, PNG)
writeFileSync(movie, WEBM)
const output = new LiveOutputServer((account, id) => {
  if (account !== 'test-operator') return null
  if (id === 'product-image') return {id,kind:'image',mime:'image/png',absolutePath:picture,size:PNG.length}
  if (id === 'product-video') return {id,kind:'video',mime:'video/webm',absolutePath:movie,size:WEBM.length}
  return null
})
let browser
try {
  output.configure('test-operator', [{id:'product-image',durationMs:1000},{id:'product-video'}])
  const url = await output.start()
  browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage({viewport:{width:1080,height:1920}})
  const exceptions = []
  page.on('pageerror', err => exceptions.push(err.message))
  await page.goto(url, {waitUntil:'domcontentloaded',timeout:20000})
  await page.waitForFunction(() => {
    const image = document.getElementById('still')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1 &&
      getComputedStyle(image).display === 'block'
  }, null, {timeout:15000})
  const started = Date.now()
  while (!output.isReady() && Date.now() - started < 10000)
    await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(output.isReady(),true,'decoded PNG must acknowledge Browser Source readiness')
  assert.equal(exceptions.length,0,'browser errors: '+exceptions.join(' / '))
  mkdirSync('test-results',{recursive:true})
  await page.screenshot({path:'test-results/obs-browser-source-real-chromium.png'})
  process.stdout.write('PASS Browser Source decodes imported PNG and acknowledges visible first frame\n')
  await page.waitForFunction(() => {
    const video = document.getElementById('moving')
    return video instanceof HTMLVideoElement && video.readyState >= 2 &&
      video.currentTime > 0.1 && getComputedStyle(video).display === 'block'
  }, null, {timeout:12000})
  await page.screenshot({path:'test-results/obs-browser-source-real-video.png'})
  process.stdout.write('PASS real Chromium decodes and plays imported VP8 WebM after image advances\n')

  const playback = output.playAudio(toneWav())
  // Playback only resolves on actual HTMLAudioElement.onended POST from Chromium;
  // no fake /audio/completed request is issued by this test.
  let timeout
  try {
    await Promise.race([
      playback,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error('Browser Source did not finish playing WAV')), 12000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  assert.equal(output.audioStatus().active,false)
  assert.equal(exceptions.length,0,'browser errors: '+exceptions.join(' / '))
  process.stdout.write('PASS real Chromium Audio played PCM WAV and sent completion acknowledgment\n')
  process.stdout.write('BOUNDARY: no OBS Studio process, RTMP receiver, platform room or audience was used\n')
} finally {
  await browser?.close()
  await output.stop()
  rmSync(dir, {recursive:true,force:true})
}
