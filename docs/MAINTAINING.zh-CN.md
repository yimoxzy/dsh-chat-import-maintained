# 维护自己的导入插件

本分支包名是 `dsh-chat-import-maintained`，首版 `0.27.0-maintained.1`，基于上游 `0.26.5` 的提交 `c6097b3`。许可证为 MIT；保留 LICENSE 中原作者版权声明。仓库未上传到个人 Git 账号，安装包未发布到 npm。

## 本地安装与升级

需要 Node.js 22.13 或以上；本分支原生运行时兼容面为 DSH `>=0.2.2-rc.1 <0.3.0`。先检查自己实际使用的 profile，以下以 `web` 为例：

```powershell
# 在 DSH 插件管理中停用原版 dsh-chat-import，再装维护版
# 将路径换为自己保存的实际安装包
 dsh plugin --profile web add ./dsh-chat-import-maintained-0.27.0-maintained.1.tgz
```

两版注册了重叠的工具与 `/api-import/` 路由，因此不能同时启用。先停用原版，保留原版包即可随时回退。新版本安装后刷新页面；请确认插件管理器显示的名称、版本和启用状态。

升级流程：修改源码 → 运行检查 → `npm pack` → 安装新 tgz → 刷新页面。不要长期编辑已安装的 node_modules，也不要让插件市场的原版更新覆盖此分支。

## 使用 Codex 项目迁移

在“导入会话”面板切换到“Codex 项目迁移”。Codex 数据目录默认使用 `CODEX_HOME`，否则为当前用户的 `.codex`。先点扫描，检查项目原名、数量、标题、推断归属和缺失正文警告，再勾选项目并导入。

工具入口 `codex_project_migrate` 默认 `preview:true`；`preview:false` 才真正写入。可传 `projectIds`、`sessionIds` 进行精确选择，`includeInferred:false` 只接受明确分配的项目。跨机器目录变化时提供 `cwdRemap:[{from:"原路径",to:"现有路径"}]`；不存在的目录会失败并报告，不自动创建空目录冒充项目恢复。

源数据库以只读模式打开。扫描合并新版 `state_*.sqlite`、`thread_history_*.sqlite`、桌面项目映射、标题索引及 JSONL，会话 ID 去重。目录推断仅接受唯一项目根目录中的普通用户线程，并排除 projectless、子代理和自动审查；它会标为推断，不能当作数据库已经保存了原生项目链接。

完整历史存入 DSH 日志，原始长文本与工具结果不做预算裁剪；末尾添加明确的归档说明检查点，避免模型每轮接收全部旧消息。此说明不是 AI 生成的历史摘要；需要历史细节时按需读取。源数据缺少图片字节、密文推理正文或已丢失消息时无法补造，结果会报告限制。

项目迁移使用 `$DSH_HOME/dsh-chat-import-maintained/codex-projects/ledger.json`。源内容未变时核验现有目标并跳过；源内容变化或显式 force 时创建新副本。用户在 DSH 中的新消息不被改写、删除或追加源消息。此前由人工脚本导入的记录不会自动认领，首次迁移前请预览，避免产生一组新的副本。

## 文件职责

| 文件或目录 | 维护内容 |
|---|---|
| `lib/codex-projects/source.mjs` | Codex 数据发现、只读数据库与路径适配 |
| `lib/codex-projects/convert.mjs` | Codex 数据库消息转完整 interchange 文档 |
| `lib/codex-projects/pipeline.mjs` | 选择、幂等账本、新会话写入、名称与工作区验收、列表同步 |
| `lib/codex-projects/register.mjs` | 工具和面板 API |
| `lib/host-invariants.mjs` | 检查点的原生计数与结构约束 |
| `src/client/codex-projects.js` | 项目迁移面板；改动后重建客户端 |
| `test/codex-project-*.test.mjs` | 合成数据库与迁移回归 |
| `test/maintained-host-invariants.test.mjs` | 工具声明、原生检查点计数与宿主格式回归 |

## 开发与检查

```powershell
npm ci --ignore-scripts
npm test
npm run lint
npm run check:linux
npm run check:links
npm run check:tests
npm run build:client
npm run build
npm pack
```

原生集成测试需要可解析的 DSH peer 依赖；本机开发可用运行时中匹配版本的包，正式发布前应在干净环境验证安装。所有测试数据库由测试代码在临时目录创建，禁止提交真实聊天记录、`.codex` 数据库、凭据或迁移备份。

测试不能只检查“文件写入成功”：至少检查原生日志读取、完整正文与工具配对、检查点计数、工作区名称与归属、真实 session.list 返回、侧栏更新通知，以及重复导入不改动用户回复。

## 合并上游更新

```powershell
# 本交付仓库已将原作者仓库命名为 upstream
# 只有自行重新克隆上游时才需要：git remote rename origin upstream
git remote add origin https://github.com/你的账号/你的仓库.git
git fetch upstream
git switch maintained/codex-projects
git merge upstream/main
# 解决冲突后运行全部检查，再更新版本和变更日志
```

先查看上游默认分支名，若不是 main，请替换为实际名称。优先保持专用迁移代码集中在 `lib/codex-projects/`，共享修正分别做清楚的提交。上游若已修复同一问题，应删除重复补丁并保留行为测试。

## 发版与回退

发布前修改包版本、同步 package-lock、写 CHANGELOG，再打包。首次安装保留旧 tgz；失败时停用维护版、启用原版，或重新安装旧维护版安装包。切换插件不会删除已有会话。

本地打包不会自动发布。只有你配置好自己的远程仓库、npm 包权限及 GitHub trusted publishing 后，才使用自己的发布流程。维护分支的 release job 默认关闭；完成配置后，在自己的 GitHub 仓库设置变量 `MAINTAINED_RELEASE_ENABLED=true` 才会启用。不要沿用上游发布身份冒充原作者发版。
