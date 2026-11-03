---
name: document-writing
description: Write documents (Feishu docx / local markdown) in the user's preferred style — plain language, detailed, no technical jargon — deliver via the correct Feishu tenant-domain link, and keep this skill's preference list updated from user feedback after every delivery.
---

# Skill: 写文档（document-writing）

按用户偏好的风格写文档，并把新学到的偏好持续记回本文件。本 skill 是活的，
不是写完一次就死的模板。

## 最重要的规则：每次写完后更新本 skill

每次写完文档，若用户给了新反馈（喜欢/不喜欢某写法、指出新坑），就把新偏好
追加到下面的"用户偏好（持续更新）"章节：一行一个条目，带日期，记"用户说了
什么 → 以后怎么写"。用户没反馈就不动。写文档的人话习惯、飞书交付的坑，都
靠这个机制一点点长出来。

## 用户的文档风格：人话、详细、不堆技术细节

用户明确说过："写的详细，人话一点，不要太多技术细节。" 落地成三条：

- **讲清楚、讲详细**：做了什么 / 结果如何 / 卡在哪 / 下一步是什么，一段一段
  讲明白。宁可长一点，不要惜字如金；用户要的是"看懂发生了什么"。
- **人话**：用普通人能懂的话。可以说"系统能正常启动了，而且挂了会自动拉起"，
  不要说"进程存活检查通过，自动重启策略生效"。
- **不堆技术细节**（去技术黑话清单，出现即违规）：
  - 不出现 commit 哈希（如 a1b2c3d）
  - 不出现类名/函数名/模块路径等代码符号
  - 不出现具体参数值（如 spawn-protection=16、timeout=30s）
  - 不出现测试条数（如"415 个测试"）
  - 不出现库/框架版本号（如 Node 22.11、pytest 8.3）
  - 技术名词必须出现时，后面跟一句人话解释（如"保护机制（防止服务被误杀）"）

## 飞书文档交付流程（含已踩过的坑）

1. **建文档**：用 task brief 给的路径读凭证（只读，凭证不进本 skill、不进
   经验日志），建目标文件夹下的 docx。坑：**batch_create 端点会 404**，正文
   要用**单块 children 端点逐块写入**。
2. **共享给作者**：把作者加为 edit 协作者。不共享用户打开就是没权限。
3. **链接分享**：用 **PATCH**（不是 POST）设置链接分享为 **tenant_editable**。
   合法枚举只有：tenant_readable / tenant_editable / anyone_readable /
   anyone_editable / closed，填别的会被拒。
4. **拿正确域名链接**：从 `GET /drive/v1/files` 返回的 **url 字段**取链接
   （形如 `ycndys4bta39.feishu.cn/docx/<id>`）。**不要用 open.feishu.cn**——
   那是开发者后台外壳，用户打开显示"页面不存在"。

交付时把"用户能打开"当验收标准：链接来自正确域名 + 已共享，缺一个都不算完。

## 用户偏好（持续更新）

格式：`- YYYY-MM-DD 用户反馈原文/要点 → 以后怎么写`。新条目往列表末尾追加，
不改动旧条目（旧偏好被推翻时新条目注明"覆盖某日条目"）。

- 2026-11-03 用户："写的详细，人话一点，不要太多技术细节" → 文档一律人话、
  详细；去掉 commit 哈希/类名/参数值/测试条数/版本号等黑话，技术词用人话解释。
- 2026-11-03 飞书链接坑 → 交付链接必须用 /drive/v1/files 的 url 字段
  （ycndys4bta39.feishu.cn 租户域名）；open.feishu.cn 用户打开是"页面不存在"。
- 2026-11-03 建文档坑 → batch_create 404，用单块 children 端点逐块写正文；
  链接分享用 PATCH + tenant_editable，先把作者加为 edit 协作者。

<!-- 新偏好追加到这里：一行一个，带日期，"用户说了什么 → 以后怎么写" -->