# writer experience log

Documentation lessons: user style preferences, Feishu delivery pitfalls,
self-updating discipline. The writer appends new preferences after each
delivery; the primary may append verified lessons. Date each entry and name
the source project. Never record secrets or project-private data.

- 2026-11-03 Created in the PiAgents agent library.
- 2026-11-03 (PiAgents): user's document style = 人话、详细、不堆技术细节; strip commit hashes, class names, parameter values, test counts, and version numbers; explain any unavoidable technical term in plain words.
- 2026-11-03 (PiAgents): Feishu delivery pitfalls — batch_create endpoint 404 (use single-block children endpoint per block); link sharing is PATCH not POST, tenant_editable, plus author as edit collaborator; the user-openable link must come from GET /drive/v1/files url field (ycndys4bta39.feishu.cn tenant domain), open.feishu.cn shows 页面不存在.