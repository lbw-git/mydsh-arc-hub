# dsh-arc-hub · 弧梦数字中枢 DSH 插件

把「弧梦数字中枢 / 海拉」接入 DeepSeek Harness：本机记忆、文件索引、真实搜索、打开目录，加上右下角数字中枢圆与设置页「弧梦中枢」。

## 安装

```
dsh plugin --profile web add github:499596849-jpg/dsh-arc-hub
```

装完**重启一次 DSH**：设置里出现「弧梦中枢」，右下角出现数字中枢圆。

## 依赖

需要先安装主程序 **ArcDream Hub**（提供 `127.0.0.1:8799` 本机服务与索引）：

- 下载：<https://github.com/499596849-jpg/arcdream-hub/releases/latest/download/arcdream-hub-0.1.2.zip>
- 解压后双击 `app\启动.cmd`

## 能力

- Host 工具：`arc_hub_status` / `arc_hub_persona`（只给摘要，不返回人设原文）/ `arc_hub_mode` / `arc_hub_search`（真实 SQLite 索引）/ `arc_hub_open_dir`
- WPS 办公工具：`arc_hub_wps_info` / `arc_hub_wps_open` / `arc_hub_wps_convert`（见下）
- Client：设置页「弧梦中枢」+ 右下角数字中枢圆（点击打开本机中枢）
- 人设卡 AES-256-GCM + Windows DPAPI 加密；模型 Key 只存本机

## WPS 办公（0.2.0 起）

插件可独立使用本机 WPS Office，无需登录中枢服务：

- `arc_hub_wps_info`：探测 WPS 安装、版本、组件与 wpscli 转换引擎支持的子命令
- `arc_hub_wps_open`：按扩展名选组件打开文件 / 新建 / 打印（`/p` 直打默认打印机）
- `arc_hub_wps_convert`：走 WPS 自带 wpscli（kpdfcli）做转换与 PDF 处理，如
  `word2pdf`、`excel2pdf`、`ppt2pdf`、`pdf2word`、`pdf2md`、`pdfmerge`、`pdfsplit`、
  `pdfcompress`、`pdfinfo`、`pdfwatermark`、`pdfencrypt` 等（完整清单以 info 为准）

说明：文件内容的生成与编辑（写报告、填表格、做幻灯片）用 DSH 自带 office
技能完成，再用本插件交给 WPS 打开或转换；wpscli 个别子命令需要登录 WPS 账号
或会员（退出码 100/101 会如实返回）。

## 权限与外部服务

插件只访问本机 `http://127.0.0.1:8799`，不上传任何数据；需本地先运行 ArcDream Hub 服务。

## 截图

![星图](https://github.com/499596849-jpg/arcdream-hub/raw/main/docs/screenshots/galaxy.png)
![设置](https://github.com/499596849-jpg/arcdream-hub/raw/main/docs/screenshots/settings.png)

## License

MIT
