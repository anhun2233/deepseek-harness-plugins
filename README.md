# DeepSeek Harness Plugins

Community plugin for the DeepSeek Harness desktop app.

| Plugin | What it does |
|---|---|
| [Session Delete](plugins/dsh-session-delete/README.md) (`dsh-session-delete`) | Adds **Delete permanently** to the session `…` menu, with a confirm dialog, and removes the session's files from the DSH data directory. |

Tested with DeepSeek Harness desktop 0.2.1-rc.2. No build step and no dependencies.

## Install

In DSH: **Plugins → Add plugin → install a third-party plugin** from a local folder. Choose `plugins/dsh-session-delete` (the folder that contains `package.json`), then enable **Session Delete** on the Plugins page.

## 中文说明

**会话删除**插件：在会话「…」菜单里加一个红色的「永久删除」，确认后从 DSH 数据目录里删掉这个会话的文件。附件和工作区里的文件不会删。安装方法：DSH「插件」→「添加插件」→「安装第三方插件」，选 `plugins/dsh-session-delete` 文件夹，然后在插件页打开「会话删除」。

## License

See [LICENSE](LICENSE).
