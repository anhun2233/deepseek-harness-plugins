# DeepSeek Harness plugins

Two plugins for the DeepSeek Harness (DSH) desktop app, plus a local client any agent can use.

| Plugin | What it does |
|---|---|
| [Agent Bridge](plugins/dsh-agent-bridge/README.md) | A loopback control API so Claude Code, Codex, Cursor, OpenClaw, or any other local agent can drive DSH. Off until you enable it. |
| [Session Delete](plugins/dsh-session-delete/README.md) | A red **Delete permanently** item on the session `…` menu. Confirms, then removes that session from the DSH data directory. |

Tested with DeepSeek Harness desktop **0.2.1-rc.2**.

## Install

Each plugin is the folder that contains its `package.json`. There is no build step and there are no dependencies.

1. Open DSH.
2. **Plugins → Add plugin → install a third-party plugin** from a local folder or a link.
3. Choose `plugins/dsh-agent-bridge` or `plugins/dsh-session-delete` (not the repository root).
4. On the Plugins page, turn the plugin on when you want it.

Agent Bridge does not listen until it is enabled. Turning it off stops the server and deletes the token file. You can install either plugin on its own. `POST /delete` on the bridge returns `501` until Session Delete is installed and enabled. The menu item does not need the bridge.

## Use the bridge from any agent

1. Enable **Agent Bridge**.
2. Give the agent [`agent-template/SKILL.md`](agent-template/SKILL.md), or paste [`agent-template/system-prompt.md`](agent-template/system-prompt.md). [`AGENTS.md`](AGENTS.md) is the same procedure for an agent that has this repository open.
3. The agent runs `node clients/dsh-bridge.mjs doctor` (Node.js 18+, macOS, Linux, and Windows) or `clients/dsh-bridge.ps1` (PowerShell). The client reads `<data-dir>/dsh-agent-bridge.json` for the port and token.

`ask` prints DSH's reply as plain text. [`docs/walkthrough.md`](docs/walkthrough.md) is the end-to-end example: the user says "go operate my DeepSeek Harness and have it say hello to you", the agent checks the discovery file, and either tells them to enable Agent Bridge or runs `ask` and relays the greeting. Hermes Agent is the worked install. Claude Code and Codex use the same command.

The data directory is `$DSH_HOME` when that variable is set, and `~/.dsh` otherwise. Set `DSH_HOME` (or pass `--home` / `-DshHome`) when DSH itself was given a different data directory. The route list is [`docs/API.md`](docs/API.md).

Selecting a model for one session may also change DSH's default model. The clients take `--restore-default` / `-RestoreDefault` to write the previous default back. They do not ship a model id; use `models` on the running app, or omit the model to keep the current default.

## Security

- Bind address is `127.0.0.1` only. Other peers get `403`.
- A random bearer token is required. Missing or wrong tokens get `401`. A new token is created every time the plugin starts.
- The discovery file is `<data-dir>/dsh-agent-bridge.json`, mode `0600` where the platform allows it. Do not commit it, print it, or tunnel the port.
- Approval mode defaults to `ui`, so DSH asks the person at the keyboard. `auto-allow` approves every tool request in that session; leave it off unless you mean it.
- Session Delete only removes session logs, the projection cache, and workspace-registry entries inside the DSH data directory. Attachments and files in the workspace stay. A session that is open in the current run leaves the list immediately and its files are removed when DSH exits or next starts. Symbolic links are not followed.

## Layout

```
plugins/dsh-agent-bridge/    Host plugin (dsh.bundle.patch, English and Chinese locales)
plugins/dsh-session-delete/  Host plugin plus the session-menu client module
clients/                     Node CLI and PowerShell CLI
docs/API.md                  HTTP reference
agent-template/              Drop-in skill and system-prompt snippet
agent-template/hermes/       Hermes Agent skill (SKILL.md) and a system-prompt snippet
docs/walkthrough.md          Hello example for Hermes, Claude Code, and Codex
AGENTS.md                    Procedure for an agent that opens this repo
scripts/check.mjs            Loads both plugins and exercises the bridge
```

`node scripts/check.mjs` checks the manifests, starts the bridge against a temporary data directory, and covers loopback binding, unauthorized requests, model-default restore, and session deletion.

## License

[MIT](LICENSE).

## 中文

本仓库是两个 DeepSeek Harness（DSH）桌面端插件的公开版本，已在 DSH 桌面版 **0.2.1-rc.2** 上测试。

**Agent Bridge（智能体桥接）** 给本机上的任意外部智能体用。默认不监听。在「插件」页打开 **Agent Bridge** 之后，才会在 `127.0.0.1` 的随机端口提供 JSON API，并用随机 Bearer 令牌保护。令牌写在 DSH 数据目录的 `dsh-agent-bridge.json`（在系统允许时权限为仅当前用户可读）。关闭插件会停掉服务并删除该文件。没有令牌的请求返回 401。数据目录由环境变量 `DSH_HOME` 决定，未设置时为 `~/.dsh`。不要把端口转发到本机之外，也不要把令牌发给别人。

可以探活、列出模型与工作区、管理会话、发送消息并等待回复、切换模型、取消、重命名、查看和设置权限预设、处理工具授权，以及读取或设置默认模型。为某个会话选择模型时，DSH 可能同时改掉默认模型。客户端用 `--restore-default`（PowerShell：`-RestoreDefault`）把原来的默认模型写回去。模型 id 以运行中的 `models` 结果为准，仓库里不写死任何模型。

**Session Delete（会话删除）** 在侧栏会话「…」菜单加入红色的「永久删除」。确认后，从 DSH 数据目录删除该会话的日志和投影缓存，并从工作区列表、归档和置顶里移除。当前进程正在使用的会话会先从列表消失，磁盘文件在退出或下次启动时删除。附件、工作区里的普通文件不会删除，符号链接也不会被跟随。子会话（subagent）会随父会话一起删除，fork 出来的独立会话不删。

桥接插件的 `POST /delete` 会调用会话删除插件的 `dshSessionDelete` 服务。没安装或没打开会话删除插件时，这个接口返回 501。只使用菜单删除时，不需要安装桥接插件。

安装：在 DSH 中打开「插件 → 添加插件 → 安装第三方插件（本地文件夹或链接）」，选择 `plugins/dsh-agent-bridge` 或 `plugins/dsh-session-delete`，再按需启用。把 `agent-template/SKILL.md` 交给另一个智能体，它就知道如何检查桥接是否已开启并调用它。

`ask` 把 DSH 的回复以纯文本打到标准输出，智能体直接转述即可。完整例子在 [`docs/walkthrough.md`](docs/walkthrough.md)：用户说「去操作我的 DeepSeek Harness，让它跟你打个招呼」。智能体检查 `dsh-agent-bridge.json`；文件不在就请用户到插件页打开 Agent Bridge；文件在就运行 `ask`，再把问候转述回来。Hermes Agent 的可安装技能在 `agent-template/hermes/`。Claude Code 和 Codex 用同一条命令。
