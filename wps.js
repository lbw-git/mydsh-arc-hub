/**
 * dsh-arc-hub · WPS 办公模块
 * 独立使用本机 WPS Office：
 *   - 发现安装（多版本取最高；AppData / Program Files 都查）
 *   - 用 WPS 组件（wps/et/wpp/wpspdf）打开、新建、打印文件
 *   - 调用 WPS 自带 wpscli（kpdfcli 引擎）做格式转换与 PDF 处理
 * 全部子进程用参数数组启动，不经 shell，无命令注入面。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

// ---------------- 安装发现 ----------------

function candidateRoots() {
  const roots = []
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Kingsoft', 'WPS Office'))
  if (process.env['ProgramFiles(x86)']) roots.push(path.join(process.env['ProgramFiles(x86)'], 'Kingsoft', 'WPS Office'))
  if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'Kingsoft', 'WPS Office'))
  return roots
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x - y
  }
  return 0
}

function versionDirs() {
  const out = []
  for (const root of candidateRoots()) {
    let names = []
    try {
      names = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch (e) { /* 该根目录不存在，忽略 */ }
    for (const n of names) out.push({ version: n, root: path.join(root, n) })
  }
  return out.sort((a, b) => cmpVersion(b.version, a.version))
}

const APP_EXES = { writer: 'wps.exe', sheet: 'et.exe', slides: 'wpp.exe', pdf: 'wpspdf.exe' }

/** 按扩展名选 WPS 组件（用于打开/打印）。 */
export function appForFile(file) {
  const ext = path.extname(String(file)).toLowerCase()
  if (['.doc', '.docx', '.wps', '.wpt', '.rtf', '.txt', '.dot', '.docm', '.odt'].includes(ext)) return 'writer'
  if (['.xls', '.xlsx', '.et', '.ett', '.csv', '.xlsm'].includes(ext)) return 'sheet'
  if (['.ppt', '.pptx', '.dps', '.dpt', '.pptm'].includes(ext)) return 'slides'
  if (ext === '.pdf') return 'pdf'
  return null
}

let _infoCache = null

/** 定位 WPS 安装与 wpscli。结果缓存（安装位置不会变）。 */
export function findWps() {
  if (_infoCache) return _infoCache
  const vers = versionDirs()
  const info = { ok: false, versions: vers.map((v) => v.version), root: null, version: null, apps: {}, wpscli: null }
  if (vers.length) {
    const best = vers[0].root
    for (const [name, exe] of Object.entries(APP_EXES)) {
      const p = path.join(best, 'office6', exe)
      info.apps[name] = { exe, path: fs.existsSync(p) ? p : null, ok: !!fs.existsSync(p) }
    }
    info.ok = !!info.apps.writer.ok || !!info.apps.sheet.ok
    if (info.ok) {
      info.root = best
      info.version = vers[0].version
      // 两个候选都要探测：clitool\\wpscli.exe 会校验父进程签名（直接 spawn 报
      // \"parent process signature verification failed\"），office6\\kwpsconvert.exe 才是可脚本化的入口。
      for (const [rel, exe] of [['office6', 'kwpsconvert.exe'], ['clitool', 'wpscli.exe']]) {
        const p = path.join(best, rel, exe)
        if (!fs.existsSync(p)) continue
        const r = runSync(p, ['--version'], 15000)
        if (r.status === 0 && /wpscli version/i.test(String(r.stdout || ''))) { info.wpscli = p; break }
      }
    }
  }
  _infoCache = info
  return info
}

function runSync(exe, args, timeout = 20000) {
  try {
    return spawnSync(exe, args, { encoding: 'utf8', timeout, windowsHide: true })
  } catch (e) {
    return { status: null, stdout: '', stderr: String(e && e.message || e), error: e }
  }
}

let _cliMeta = null

/** wpscli 版本（wpscli 引擎 + 技能版本）。 */
export function cliVersion() {
  const info = findWps()
  if (!info.wpscli) return null
  if (_cliMeta && _cliMeta.ver) return _cliMeta.ver
  const r = runSync(info.wpscli, ['--version'])
  const text = String(r.stdout || '').trim()
  const m = text.match(/wpscli version\s+([\d.]+).*?skill version\s+([\d.]+)/i)
  const ver = { raw: text, wpscli: m ? m[1] : null, skill: m ? m[2] : null }
  _cliMeta = Object.assign(_cliMeta || {}, { ver })
  return ver
}

/** wpscli 支持的子命令清单（解析 --help，缓存）。 */
export function cliSubs() {
  const info = findWps()
  if (!info.wpscli) return []
  if (!_cliMeta || !_cliMeta.subs) {
    const r = runSync(info.wpscli, ['--help'])
    const text = String(r.stdout || '') + '\n' + String(r.stderr || '')
    const subs = []
    const re = /^\s+([a-z][a-z0-9]+)\s{2,}[A-Z]/gm
    let m
    while ((m = re.exec(text)) !== null) {
      if (!subs.includes(m[1]) && !['install', 'feedback', 'usage'].includes(m[1])) subs.push(m[1])
    }
    _cliMeta = Object.assign(_cliMeta || {}, { subs })
  }
  return _cliMeta.subs
}

/** COM 自动化接口可用性（KWPS/KET/KPP；个人版通常未注册）。 */
export function comCheck() {
  const out = {}
  for (const [k, id] of Object.entries({ kwps: 'KWPS.Application', ket: 'KET.Application', kpp: 'KPP.Application' })) {
    const r = runSync('reg.exe', ['query', 'HKEY_CLASSES_ROOT\\' + id, '/ve'], 8000)
    out[k] = r.status === 0
  }
  return out
}

/** 完整能力信息（arc_hub_wps_info 的返回体）。 */
export function info() {
  const w = findWps()
  if (!w.ok) {
    return { ok: false, found: false, hint: '未找到 WPS Office 安装（AppData\\Local\\Kingsoft 或 Program Files 下都没有）' }
  }
  return {
    ok: true,
    found: true,
    version: w.version,
    versions: w.versions,
    root: w.root,
    apps: w.apps,
    wpscli: {
      path: w.wpscli,
      version: w.wpscli ? cliVersion() : null,
      subcommands: w.wpscli ? cliSubs() : [],
    },
    com: comCheck(),
  }
}

// ---------------- 启动 WPS（打开 / 新建 / 打印） ----------------

function launch(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child.pid
}

/**
 * action:
 *  open  – 按扩展名选组件打开文件（默认）
 *  new   – 打开对应组件的开始页（新建入口）
 *  print – 用 WPS 打印到默认打印机（wps/et 直打；wpp 可能弹打印对话框）
 */
export function open(args = {}) {
  const w = findWps()
  if (!w.ok) throw new Error('未找到 WPS Office 安装')
  const action = args.action === 'new' || args.action === 'print' ? args.action : 'open'

  if (action === 'new') {
    const app = APP_EXES[args.app] ? args.app : 'writer'
    const exe = w.apps[app] && w.apps[app].path
    if (!exe) throw new Error('缺少 WPS 组件：' + app)
    launch(exe, [])
    return { ok: true, action, app, exe }
  }

  if (!args.file) throw new Error('action=open/print 需要 file')
  const file = path.resolve(String(args.file))
  if (!fs.existsSync(file)) throw new Error('文件不存在：' + file)
  const app = appForFile(file)
  if (!app) throw new Error('没有 WPS 组件匹配该扩展名：' + path.extname(file))
  const exe = w.apps[app] && w.apps[app].path
  if (!exe) throw new Error('缺少 WPS 组件：' + app)
  const argv = action === 'print' ? ['/p', file] : [file]
  launch(exe, argv)
  return { ok: true, action, app, exe, file }
}

// ---------------- wpscli 转换 ----------------

const EXIT_MEANING = {
  0: '成功',
  100: '未登录 WPS 账号（需先登录）',
  101: '需要 WPS 会员权限',
  207: '输入文件超过 200MB',
  209: '缺少打开密码',
  210: '打开密码错误',
  429: '请求过于频繁或当日额度用尽',
}

const DENY_SUBS = ['install', 'feedback']

function sanitizeOption(opt) {
  const s = String(opt)
  if (s.length > 200) throw new Error('选项过长')
  if (/['"`$&|<>\\]/.test(s)) throw new Error('选项包含非法字符：' + s)
  return s
}

/**
 * 调用 wpscli 做格式转换 / PDF 处理。
 * @param {object} args { sub, inputs[], output?, outputDir?, options[], timeoutMs? }
 *  output    – 单个输出文件路径（父目录不存在会自动创建）
 *  outputDir – 输出目录（批量模式，省略则输出到输入同目录）
 */
export async function convert(args = {}) {
  const w = findWps()
  if (!w.ok) throw new Error('未找到 WPS Office 安装')
  if (!w.wpscli) throw new Error('未找到 wpscli（WPS 12.1+ 自带，位于 clitool\\wpscli.exe）')

  const sub = String(args.sub || '')
  if (!/^[a-z][a-z0-9]{1,30}$/.test(sub)) throw new Error('非法的 sub 命令名：' + sub)
  if (DENY_SUBS.includes(sub)) throw new Error('sub 不支持：' + sub)

  const rawInputs = Array.isArray(args.inputs) ? args.inputs : [args.input]
  const inputs = rawInputs.filter(Boolean).map((p) => path.resolve(String(p)))
  if (!inputs.length) throw new Error('缺少 inputs（至少一个输入文件）')
  for (const p of inputs) if (!fs.existsSync(p)) throw new Error('输入文件不存在：' + p)

  if (args.output && args.outputDir) throw new Error('output 与 outputDir 二选一，不能同时给')

  const argv = [sub, ...inputs]
  if (args.output) {
    const out = path.resolve(String(args.output))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    argv.push('-o', out)
  }
  if (args.outputDir) {
    const dir = path.resolve(String(args.outputDir))
    fs.mkdirSync(dir, { recursive: true })
    argv.push('-o', dir)
  }
  if (args.options) {
    const opts = Array.isArray(args.options) ? args.options : [args.options]
    if (opts.length > 16) throw new Error('options 最多 16 个')
    for (const o of opts) argv.push(sanitizeOption(o))
  }
  argv.push('--json')

  const timeout = Math.min(Math.max(Number(args.timeoutMs) || 240000, 10000), 600000)
  const started = Date.now()

  const res = await new Promise((resolve) => {
    const child = spawn(w.wpscli, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timer = null
    const cap = (s) => (s.length > 200000 ? s.slice(-200000) : s)
    child.stdout.on('data', (d) => { stdout = cap(stdout + d) })
    child.stderr.on('data', (d) => { stderr = cap(stderr + d) })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr, spawnError: String(err && err.message || err) })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ exitCode: code, signal: signal || null, stdout, stderr })
    })
    timer = setTimeout(() => {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch (e) { /* ignore */ }
      resolve({ exitCode: null, timedOut: true, stdout, stderr })
    }, timeout)
  })

  // 解析逐行 JSON 事件；非 JSON 行归入 stray
  const events = []
  const stray = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { events.push(JSON.parse(t)) } catch (e) { stray.push(t) }
  }
  const done = [...events].reverse().find((e) => e && (e.type === 'completed' || e.type === 'error'))
  const outputPath = done && (done.output || done.file || null)
  // pdfinfo 等查询类子命令的 completed 事件没有 status 字段，按 exitCode+type 判定
  const ok = res.exitCode === 0 && !!done && done.type === 'completed' && (done.status == null || done.status === 'success')
  const tail = events.slice(-30)

  return {
    ok,
    sub,
    command: [w.wpscli, ...argv].join(' '),
    exitCode: res.exitCode,
    meaning: EXIT_MEANING[res.exitCode] || (res.exitCode === null ? (res.timedOut ? '执行超时（已强制结束）' : '启动失败') : '未知退出码'),
    timedOut: !!res.timedOut,
    spawnError: res.spawnError || null,
    elapsedMs: Date.now() - started,
    output: ok ? outputPath : null,
    events: tail,
    strayTail: stray.slice(-5),
    stderrTail: res.stderr.split(/\r?\n/).slice(-8).join('\n').trim(),
  }
}
