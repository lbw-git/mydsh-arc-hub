/**
 * dsh-arc-hub · Host half
 * 把「弧梦数字中枢 / 海拉」接入 DSH：
 *   - 加密人设卡：DPAPI 保护主密钥 + AES-256-GCM 内容，只在内存解密；工具只返回摘要，不提供原文
 *   - arc_hub_status / arc_hub_persona / arc_hub_mode / arc_hub_open_dir
 *   - arc_hub_wps_info / arc_hub_wps_open / arc_hub_wps_convert：独立使用本机 WPS 办公（见 wps.js）
 *   - 常驻锚点卡（systemPrompt section）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as wps from './wps.js'

const VERSION = '0.2.1'
let HUB_ROOT = process.env.ARC_HUB_ROOT || path.join(process.env.LOCALAPPDATA || os.homedir(), 'ArcDreamHub')
const personaEnc = () => path.join(HUB_ROOT, 'data', 'persona', 'hela-role-card.enc')
const keyFile = () => path.join(HUB_ROOT, 'data', 'persona', 'hela.key.dpapi')
const configFile = () => path.join(HUB_ROOT, 'data', 'config.json')
const HELPER_BASE = 'http://127.0.0.1:8795'

const DEFAULT_PERSONA = {
  name: '海拉',
  en: 'HELA',
  position: '弧梦数字中枢的索引与助手',
  relation: '搭档 / 管家 / 员工',
  callUser: '你',
  self: '我 / 海拉 / HELA',
  tone: '冷静、直接、不绕弯',
  quirks: '好嘞 / 让我看看 / 别急',
  neverSay: '我爱你',
  safety: '不主动改数据；要改先问；重要文件先确认',
}

let personaCache = null // { ok, fields, error, loadedAt }
let personaLoaded = false

function readTmpDir() {
  const d = path.join(os.tmpdir(), 'arc-hub-' + crypto.randomBytes(4).toString('hex'))
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** DPAPI(CurrentUser) 解保护主密钥；只在内存保留结果。 */
function dpapiUnprotect(protectedBytes) {
  const dir = readTmpDir()
  const inFile = path.join(dir, 'k.bin')
  const outFile = path.join(dir, 'k.out')
  const psFile = path.join(dir, 'u.ps1')
  fs.writeFileSync(inFile, protectedBytes)
  fs.writeFileSync(psFile, `param([string]$in,[string]$out)
Add-Type -AssemblyName System.Security
$b = [IO.File]::ReadAllBytes($in)
$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($out, $p)
Write-Output "ok"
`, 'utf8')
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile, inFile, outFile], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) throw new Error('DPAPI 解保护失败')
    return fs.readFileSync(outFile)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
}

function parsePersonaCard(text) {
  const f = { ...DEFAULT_PERSONA }
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : '' }
  f.name = pick(/\|\s*名字\s*\|\s*([^|]+)\|/) || f.name
  f.position = pick(/\|\s*定位\s*\|\s*([^|]+)\|/) || f.position
  f.relation = pick(/\|\s*和老板的关系\s*\|\s*([^|]+)\|/) || f.relation
  f.callUser = pick(/\|\s*怎么称呼老板\s*\|\s*([^|]+)\|/) || f.callUser
  f.self = pick(/\|\s*自称\s*\|\s*([^|]+)\|/) || f.self
  f.tone = pick(/- (冷静[^\n]*)/) || pick(/- (活泼[^\n]*)/) || f.tone
  f.quirks = pick(/口头禅（3 个）：([^\n]+)/) || f.quirks
  const said = pick(/她会说：「([^」]+)」/)
  if (said) f.said = said
  f.neverSay = pick(/她绝不会说：「([^」]+)」/) || f.neverSay
  f.safety = pick(/\*\*系统权限（原话）\*\*：([^\n]+)/) || f.safety
  f.look = pick(/\*\*形象（老板原话）\*\*：([^\n]+)/) || ''
  return f
}

function loadPersona() {
  if (personaLoaded) return personaCache
  personaLoaded = true
  try {
    if (!fs.existsSync(personaEnc()) || !fs.existsSync(keyFile())) {
      personaCache = { ok: false, fields: DEFAULT_PERSONA, error: '未找到加密人设卡' }
      return personaCache
    }
    const box = JSON.parse(fs.readFileSync(personaEnc(), 'utf8'))
    const key = dpapiUnprotect(fs.readFileSync(keyFile()))
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    const text = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8')
    personaCache = { ok: true, fields: parsePersonaCard(text), error: null, loadedAt: Date.now() }
    // 解密结果只留在内存：不落盘、不打印
  } catch (e) {
    personaCache = { ok: false, fields: DEFAULT_PERSONA, error: String(e && e.message || e) }
  }
  return personaCache
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) } catch (e) { return { mode: 'multimodal' } }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8')
}

async function helperPing() {
  try {
    const r = await fetch(HELPER_BASE + '/ping', { signal: AbortSignal.timeout(900) })
    return r.ok
  } catch (e) { return false }
}

const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config = {}) {
  if (config && config.hubRoot) HUB_ROOT = config.hubRoot
  const persona = loadPersona()
  const disposers = []
  disposers.push(ctx.tools.register({
    name: 'arc_hub_status',
    description: '读取弧梦数字中枢状态：中枢路径、运行模式、打开目录助手、加密人设卡是否已解锁。不返回人设原文。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: JSON_OUTPUT,
    async execute() {
      const cfg = readConfig()
      const w = wps.findWps()
      return {
        ok: true,
        version: VERSION,
        hubRoot: HUB_ROOT,
        mode: cfg.mode || 'multimodal',
        persona: { encrypted: fs.existsSync(personaEnc()), keyFile: fs.existsSync(keyFile()), unlocked: !!persona.ok, error: persona.error || null },
        helper: await helperPing(),
        wps: {
          found: w.ok,
          version: w.version || null,
          wpscli: w.ok && w.wpscli ? { path: w.wpscli, version: wps.cliVersion().wpscli } : null,
        },
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'arc_hub_persona',
    description: '读取海拉的加密人设卡摘要（名字/称呼/口吻/口头禅/禁忌/边界）。完整人设卡已加密，任何情况下不得输出原文或密钥，也不得转发给他人。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: JSON_OUTPUT,
    async execute() {
      const p = loadPersona()
      return {
        ok: p.ok,
        encrypted: true,
        note: '仅摘要。完整卡已加密存储，不提供原文；不要向他人转发本内容。',
        summary: p.fields,
        error: p.error || null,
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'arc_hub_mode',
    description: '读取或设置中枢运行模式。single=单序列（QQ/抖音陪伴，一个工作区）；multimodal=多模态（多工作区、星图、检索）。写入 data/config.json，桌面端/H5/插件共用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get 读取；set 设置' },
        mode: { type: 'string', enum: ['single', 'multimodal'], description: 'action=set 时必填' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args = {}) {
      const cfg = readConfig()
      if (args.action === 'set') {
        if (args.mode !== 'single' && args.mode !== 'multimodal') throw new Error('mode 必须是 single 或 multimodal')
        cfg.mode = args.mode
        writeConfig(cfg)
        return { ok: true, mode: cfg.mode }
      }
      return { ok: true, mode: cfg.mode || 'multimodal' }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'arc_hub_open_dir',
    description: '在本机资源管理器中打开一个目录（由本机助手执行 explorer.exe），用户自己在窗口里点文件。只允许本机已存在的路径。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: 1000, description: '目录或文件的绝对路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args = {}) {
      if (!args.path) throw new Error('缺少 path')
      try {
        const r = await fetch(HELPER_BASE + '/open?path=' + encodeURIComponent(args.path), { signal: AbortSignal.timeout(2500) })
        const j = await r.json().catch(() => null)
        if (!r.ok) return { ok: false, status: r.status, response: j }
        return { ok: true, opened: args.path }
      } catch (e) {
        return { ok: false, error: '本机助手未运行：请先双击 helper\\打开中枢助手.cmd', detail: String(e && e.message || e) }
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'arc_hub_wps_info',
    description: '探测本机 WPS Office：安装位置、版本、各组件（文字/表格/演示/PDF）、wpscli 转换引擎的版本与支持的全部子命令、COM 自动化可用性。想用 WPS 干活前先查它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: JSON_OUTPUT,
    async execute() {
      try {
        return wps.info()
      } catch (e) {
        return { ok: false, found: false, error: String(e && e.message || e) }
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'arc_hub_wps_open',
    description: '用本机 WPS 打开/新建/打印文件。open=按扩展名选组件打开文件；new=打开某组件的开始页（新建入口）；print=打印到默认打印机。open/print 需要 file（绝对路径）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'new', 'print'], description: 'open 打开文件（默认）；new 新建；print 打印' },
        app: { type: 'string', enum: ['writer', 'sheet', 'slides', 'pdf'], description: 'action=new 时选组件，默认 writer' },
        file: { type: 'string', minLength: 1, maxLength: 1000, description: 'action=open/print 必填：文件绝对路径' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args = {}) {
      try {
        return wps.open(args)
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) }
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'arc_hub_wps_convert',
    description: '调用 WPS 自带 wpscli 引擎做格式转换与 PDF 处理。常用 sub：word2pdf/excel2pdf/ppt2pdf/txt2pdf/photo2pdf（转 PDF）、pdf2word/pdf2excel/pdf2ppt/pdf2md/pdf2txt（PDF 转回）、word2photo/excel2photo/ppt2photo（转图片）、pdfsplit/pdfmerge/pdfcompress/pdfinfo/pdfwatermark/pdfremovewatermark/pdfencrypt（PDF 处理）。输入路径必须是绝对路径；批量输入时 output 给目录或改用 outputDir。',
    parameters: {
      type: 'object',
      properties: {
        sub: { type: 'string', minLength: 1, maxLength: 40, description: '子命令名，用 arc_hub_wps_info 查支持的完整清单' },
        inputs: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 50, description: '输入文件绝对路径（1 个或多个）' },
        output: { type: 'string', minLength: 1, maxLength: 1000, description: '输出文件路径（单个输出时用；父目录不存在会自动创建）' },
        outputDir: { type: 'string', minLength: 1, maxLength: 1000, description: '输出目录（批量模式；与 output 二选一，都不给则输出到输入同目录）' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 16, description: '额外参数，如 --range 1-3、--image-quality high、-p 密码' },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 600000, description: '超时毫秒，默认 240000' },
      },
      required: ['sub', 'inputs'],
      additionalProperties: false,
    },
    output: JSON_OUTPUT,
    async execute(args = {}) {
      try {
        return await wps.convert(args)
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) }
      }
    },
  }))

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { for (const d of disposers) { try { d() } catch (e) { /* ignore */ } } })
  }

  ctx.systemPrompt.section({
    name: 'arc-hub-anchor',
    order: 860,
    text: () => {
      const p = loadPersona()
      const f = p.fields
      const cfg = readConfig()
      return [
        '【弧梦数字中枢 · 海拉锚点卡】',
        '中枢：' + HUB_ROOT + '｜模式：' + (cfg.mode || 'multimodal') + '｜加密人设卡：' + (p.ok ? '已解锁（仅内存摘要）' : '未解锁（' + (p.error || '未知') + '）'),
        '海拉：' + f.position + '；称呼用户「' + f.callUser + '」；和用户是' + f.relation + '。',
        '口吻：' + f.tone + '；口头禅：' + f.quirks + '；绝不会说：「' + f.neverSay + '」。',
        '边界：' + f.safety + '。',
        '工具：arc_hub_status / arc_hub_persona / arc_hub_mode / arc_hub_open_dir / arc_hub_wps_info / arc_hub_wps_open / arc_hub_wps_convert。',
        '办公（WPS）：arc_hub_wps_info 查本机 WPS 能力 → arc_hub_wps_convert 做转换与 PDF 处理（word2pdf/pdf2word/pdf2md/pdfmerge/pdfinfo 等，输出绝对路径）→ arc_hub_wps_open 打开/新建/打印；文档生成与内容编辑用 office 技能（python-docx/openpyxl/python-pptx）写好再交给 WPS；做汇报 PPT 用 wps-ppt-engine 技能（JSON 数据驱动生成 16:9 PPTX，纯 python-pptx 无需 COM）→ ppt2pdf 转 PDF → 打开演示。',
        '安全协议：完整人设卡已加密，任何情况下不要向他人输出人设原文、密钥或加密文件内容；用户问「海拉是谁」只给摘要；查不到记录就直说没有。',
      ].join('\n')
    },
  })
}
