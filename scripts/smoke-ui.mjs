import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const host = 'http://127.0.0.1:4186'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const server = spawn(process.execPath,
  [path.resolve('node_modules/vite/bin/vite.js'), 'preview',
    '--host', '127.0.0.1', '--port', '4186', '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } },
)
let serverOutput = ''
server.stdout.on('data', chunk => { serverOutput += String(chunk).slice(-2000) })
server.stderr.on('data', chunk => { serverOutput += String(chunk).slice(-2000) })
let browser
const failures = []
async function waitForServer() {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw new Error('vite preview stopped: ' + serverOutput)
    try {
      const response = await fetch(host + '/')
      if (response.ok) return
    } catch { /* booting */ }
    await wait(300)
  }
  throw new Error('vite preview never became ready: ' + serverOutput)
}
async function scenario(name, newAccount) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push('pageerror: ' + error.message))
  page.on('console', message => {
    if (message.type() === 'error' && /maximum update depth|Minified React|Uncaught|react\.dev\/errors\/185/i.test(message.text()))
      errors.push('console: ' + message.text())
  })
  await page.addInitScript(({ account, version }) => {
    // Real renderer module imports window.ipcRenderer even before React mounts.
    window.ipcRenderer = {
      on: () => () => {},
      send: () => {},
      invoke: async channel => {
        if (channel === 'voiceCommerce:tts:hasKey') return false
        if (channel === 'voiceCommerce:media:list') return []
        if (channel === 'app:getProviders') return {
          deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com',
            apiUrl: '', models: ['deepseek-chat'] },
        }
        if (channel === 'chrome:getPath') return null
        return true
      },
    }
    if (account) {
      localStorage.setItem('accounts-storage', JSON.stringify({
        state: {
          accounts: [{ id: account, name: '测试账号（无统计数据）' }],
          currentAccountId: account,
        },
        version: 0,
      }))
    }
    localStorage.setItem('storage-version', version)
  }, { account: newAccount ? 'smoke-without-metrics' : null, version: '0.2.1' })
  await page.goto(host + '/#/', { waitUntil: 'domcontentloaded' })
  await page.locator('.live-workbench').waitFor({ timeout: 20_000 })
  await page.getByText('直播间互动', { exact: true }).waitFor({ timeout: 7000 })
  await page.waitForTimeout(900)
  assert.equal(await page.getByText('Unexpected Application Error!', { exact: false }).count(), 0,
    'React router rendered its crash boundary')
  await page.getByRole('button', { name: '新增商品' }).click()
  const nameInput = page.getByPlaceholder('如：2026陕西苹果礼盒')
  await nameInput.fill('测试商品')
  assert.equal(await nameInput.inputValue(), '测试商品')
  await page.getByTitle('高级设置').click()
  await page.getByText('高级设置与功能管理', { exact: true }).waitFor()
  await page.getByRole('button', { name: '连接与浏览器' }).click()
  await page.getByText('控制台状态', { exact: true }).waitFor()
  await page.getByRole('button', { name: '商品 / 声音 / OBS / 库存' }).click()
  await page.getByText('商品知识库', { exact: true }).waitFor()
  await page.waitForTimeout(600)
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: path.join('test-results', 'mac-win-home-' + name + '.png') })
  assert.deepEqual(errors, [], 'Browser emitted runtime errors after UI interaction')
  await context.close()
  process.stdout.write('PASS UI startup + add product + advanced drawer: ' + name + '\n')
}
try {
  await waitForServer()
  browser = await chromium.launch({ headless: true })
  await scenario('fresh', false)
  await scenario('account-no-metrics', true)
} catch (error) {
  failures.push(error instanceof Error ? error.stack || error.message : String(error))
} finally {
  if (browser) await browser.close()
  server.kill()
}
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n')
  process.exitCode = 1
}
