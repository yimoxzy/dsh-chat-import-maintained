# 维护自己的导入插件

本分支包名是 `dsh-chat-import-maintained`，当前版本 `0.28.0-maintained.1`，基于上游 `0.26.5` 的提交 `c6097b3`。许可证为 MIT；保留 LICENSE 中原作者版权声明。维护源码位于 [yimoxzy/dsh-chat-import-maintained](https://github.com/yimoxzy/dsh-chat-import-maintained)，安装包尚未发布到 npm。

## 本地安装与升级

需要 Node.js 22.13 或以上；本分支原生运行时兼容面为 DSH `>=0.2.2-rc.1 <0.3.0`。先检查自己实际使用的 profile，以下以 `web` 为例：

```powershell
# 在 DSH 插件管理中停用原版 dsh-chat-import，再装维护版
# 将路径换为自己保存的实际安装包
dsh plugin --profile web add ./dsh-chat-import-maintained-0.28.0-maintained.1.tgz
```

两版注册了重叠的工具与 `/api-import/` 路由，因此不能同时启用。先停用原版，保留原版包即可随时回退。新版本安装后刷新页面；请确认插件管理器显示的名称、版本和启用状态。

升级流程：修改源码 → 运行检查 → `npm pack` → 安装新 tgz → 刷新页面。不要长期编辑已安装的 node_modules，也不要让插件市场的原版更新覆盖此分支。

## 使用 Codex 项目迁移

在“导入会话”的普通“导入”页选择来源 **Codex**，使用统一的项目扫描与导入流程；不再另设“Codex 项目迁移”页。Codex 数据目录默认使用 `CODEX_HOME`，否则为当前用户的 `.codex`。先扫描，检查项目原名、数量、标题、推断归属、动作分类和缺失正文警告，再勾选需要处理的会话并明确点击导入。扫描及规划均只读。直接文件/JSONL 导入与全部来源扫描仍走上游通用路径。

工具入口 `codex_project_migrate` 默认 `preview:true`；`preview:false` 才真正写入。可传 `projectIds`、`sessionIds` 进行精确选择，`includeInferred:false` 只接受明确分配的项目。跨机器目录变化时提供 `cwdRemap:[{from:"原路径",to:"现有路径"}]`；不存在的目录会失败并报告，不自动创建空目录冒充项目恢复。

源数据库以只读模式打开。扫描合并新版 `state_*.sqlite`、`thread_history_*.sqlite`、桌面项目映射、标题索引及 JSONL，会话 ID 去重。目录推断仅接受唯一项目根目录中的普通用户线程，并排除 projectless、子代理和自动审查；它会标为推断，不能当作数据库已经保存了原生项目链接。

完整历史存入 DSH 日志，原始长文本与工具结果不做预算裁剪；末尾添加明确的归档说明检查点，避免模型每轮接收全部旧消息。此说明不是 AI 生成的历史摘要；需要历史细节时按需读取。源数据缺少图片字节、密文推理正文或已丢失消息时无法补造，结果会报告限制。

项目迁移使用 `$DSH_HOME/dsh-chat-import-maintained/codex-projects/ledger.json`。规划显示七种动作：`new` 新导入、`unchanged` 未变化、`adoptable` 可核验认领、`update` 可安全追加、`conflict` 冲突需副本、`ambiguous` 证据不唯一或不足、`missing` 无正文。点击导入前不会写账本或消息。

此前由通用插件或脚本导入的会话可通过旧来源注册表、精确源 ID、完整源文档或可选迁移清单 `adoptionManifest` 建立候选，但必须核验工作目录/工作区归属和完整内容前缀；绝不按会话名猜测，已归档重复副本不参与候选。相同且唯一的旧会话可只登记账本，不新增历史消息；已有 DSH 续聊保留并标记。旧源文件缺失、记录不可读、完整内容无法核实或多条活动候选时，不会自动认领。

源增加新轮次时，只有旧源轮次是新源的完整前缀、目标消息 atom 哈希仍等于基线、未标记 DSH 续聊且满足受保护的原生写入条件，才向同一会话追加新增轮次。冷会话取得独占写租约后重新读取全部目标事件；已加载会话先用独立原生 Session 预检拟追加日志，再检查当前实例、完整日志哈希和空闲状态，并在无异步间隙的同步追加段中提交。竞争修改、重复工具 ID、运行中会话或缺少所需原生能力会拒绝。仅标题等元数据变化时通过同样保护安全追加标题事件。DSH 续聊/编辑、源历史改写，或旧迁移无法证明轮次追加边界时，显示冲突，只有点击导入后才新建完整副本。`force` 可为已验证来源请求副本，但不能绕过 `ambiguous` 或补造 `missing`。不会自动删除、覆盖或重写旧历史。

原项目目录已移动时，只有唯一候选的实际 header 路径与保留工作区归属得到核验，才复用该保留目录并记入账本；否则提供指向现有目录的 `cwdRemap`。插件不会为缺失源目录创建空文件夹冒充恢复。详细判据见[迁移契约](CODEx-PROJECTS.md)。

## 文件职责

| 文件或目录 | 维护内容 |
|---|---|
| `lib/codex-projects/source.mjs` | Codex 数据发现、只读数据库与路径适配 |
| `lib/codex-projects/convert.mjs` | Codex 数据库消息转完整 interchange 文档 |
| `lib/codex-projects/pipeline.mjs` | 选择、账本、动作执行、名称与工作区验收、列表同步 |
| `lib/codex-projects/plan.mjs` | 只读分类与前缀/目标基线判定 |
| `lib/codex-projects/adoption.mjs` | 旧注册表与迁移清单候选、精确身份及完整内容核验 |
| `lib/codex-projects/updates.mjs` | 独占租约下的轮次追加及元数据追加 |
| `lib/codex-projects/register.mjs` | 工具和面板 API |
| `lib/host-invariants.mjs` | 检查点的原生计数与结构约束 |
| `src/client/` | 普通导入页的 Codex 项目列表、动作分类与选择；改动后重建客户端 |
| `test/codex-project-*.test.mjs` | 合成数据库与迁移回归 |
| `test/maintained-host-invariants.test.mjs` | 工具声明、原生检查点计数与宿主格式回归 |

## 开发与检查

```powershell
npm ci --legacy-peer-deps --ignore-scripts
# 换成已安装的 @deepseek-ai/dsh 包目录，脚本只链接其公开运行时依赖
node scripts/link-host-peers.mjs --runtime-root "C:\path\to\node_modules\@deepseek-ai\dsh"
npm test
npm run lint
npm run check:linux
npm run check:links
npm run check:tests
npm run build:client
npm run build
npm pack
```

开发锁文件只锁本地开发依赖；DSH peer 由当前宿主提供，不让 npm 自动混装旧世代运行时。链接脚本要求 DSH >=0.2.2-rc.1，已存在且指向别处的依赖会拒绝覆盖，缺失必需包会明确报错；也可通过 DSH_RUNTIME_ROOT 指定运行时目录。发布安装包仍声明 peer 兼容范围，由 DSH 插件管理器解析。所有测试数据库由测试代码在临时目录创建，禁止提交真实聊天记录、`.codex` 数据库、凭据或迁移备份。

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
