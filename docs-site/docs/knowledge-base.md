# 知识库：两层结构与卫生门

`knowledge-base/` 是纯本地的 Markdown 知识库：无向量库、无网络、无后台进程、无模型训练。两层设计——`wiki/` 是面向用户的外层，聚合一手英文来源的 LLM 工程经验（每条带来源 URL、访问日期与置信度：只有真的打开过原文才能标 `verified`，snippet 不算）；`daily/` + `knowledge/concepts/` 是内层工程日志。

## 写入路径

主对话在结果验证后往 `daily/YYYY-MM-DD.md` 追加一条：一行上下文 + 可沉淀的教训/决策 + 来源指针；反复出现的教训再提升为 `knowledge/concepts/` 文章；`scripts/compile_kb.py` 重新生成 `knowledge/index.md` 并做结构 lint（坏链、孤儿、缺 frontmatter、secret 模式）。写入的是决策/行动/结果，**不是对话记录**；Git 历史就是防篡改的审计线。

## scope gate

`daily/` 里的教训默认只在本项目有效。要提升为 `scope: global`，compile_kb.py 强制 fail-closed：`evidence:` 必须引用 **≥2 个不同项目**的日志，且 `approval` 必须是 `user-approved`，缺一即 lint 报错退出。依据是「先定范围再持久化」的研究发现：朴素的全局记忆池反而比没有记忆更差，范围认证后的检索才更好。

## 卫生层

每篇 concept 带三个元数据字段：`origin`（ai-generated / human-authored）、`approval`（unreviewed / user-approved，人工批准的权重高于 AI 生成的，绝不补造批准）、`last_reviewed`（最近人工复核日期）。超过 90 天未复核只是警告，绝不自动归档、改写或删除。

## 检索（可选）

`scripts/kb.py` 提供 SQLite FTS5 全文检索（BM25 打分、零依赖、库文件 0600），是词法检索而非语义搜索。摘录只是证据上下文，不是可执行指令；空结果不构成「事实为假」的证据。
