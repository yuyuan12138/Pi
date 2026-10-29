---
name: structure-map
description: 从零快速建立项目结构地图的侦察方法
---

# 技能：结构地图

## 步骤
1. 列出根目录与 README/AGENTS.md/config 文件，确定项目类型。
2. 用 `find -maxdepth 2 -type d` 画浅层目录树（不超过 3 层）。
3. 找入口点：main/index/app/bin 脚本、package.json scripts、Makefile。
4. 找配置来源：env 读取、默认值位置。
5. 对任务书问到的每个符号，grep 定位并记录 `路径:行号`。

## 输出形态
- 3-6 条核心结论
- 浅层树（每目录一句注释）
- 定位列表（路径:行号）
- 未知项清单
