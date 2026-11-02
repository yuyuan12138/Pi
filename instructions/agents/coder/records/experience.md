# coder experience log

Implementation lessons: scoping, test strategy, honest reporting. Append one-line lessons after verified results; date each entry and
name the source project. Never record project-private data.

- 2026-10-29 Created in the PiAgents agent library.
- 2026-11-02 (Minecraft infra): wrap SDK calls with mutationStarted so pre-mutation parameter errors stay recoverable while post-mutation rejections abort terminally — a rejected craft does NOT prove no server effect.
- 2026-11-02 (Minecraft infra): mineflayer pre-packet local-check exceptions ('missing ingredient', 'must be holding an item') must be mapped to known machine codes or they degrade to outcome-unknown terminal kills.
- 2026-11-02 (medical-system): class-level @Transactional tests hide lazy-init failures that occur in real HTTP requests; regression tests need NOT_SUPPORTED propagation or commit/reopen.
- 2026-11-02 (Minecraft infra): every layer that independently validates a value (timeout, heap size) must be updated together; missing one layer surfaces as an unrelated transport failure.
