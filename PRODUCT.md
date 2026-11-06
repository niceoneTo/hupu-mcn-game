# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

- **Core Runtime**: Pure native HTML5, CSS3, ES6+ JavaScript, Web Audio API.
- **Dependency Strategy**: 100% self-contained single-file architecture; zero external CDNs, scripts, or fonts. Fully offline-capable.
- **Platform Bridge & Extension**: Standardized `HupuBridge` hook interfaces pre-wired for Hupu user login, cloud save, and community leaderboards API.

## Users

- **Primary Audience**: 虎扑社区 JRs（步行街/数码/电竞板块泛年轻潮流用户）。
- **Usage Situation**: 手机碎片化场景（通勤、赛后闲暇、午休），主要通过虎扑 App 内嵌 WebView、微信朋友圈/H5 分享链接或移动浏览器打开。
- **User Job**: 寻找快节奏、强反馈、带有社区梗文化与逆袭爽感的轻度商战经营体验，追求在有限周数内打造商业帝国并冲击 JRs 9.9 满分神作评价。

## Product Purpose

- 模拟从前东家负气出走、手握 100 万启动资金重起炉灶的现代 MCN 机构主理人成长之路。
- 构建“工作日精细养成与基建升级 + 周末 15 秒高能手速带货对战 + 突发行业商战舆情决策”的每周核心闭环。
- 交付符合虎扑 AI 工坊生产级标准、兼具竞技爽感与文化认同的高质量互动小游戏。

## Positioning

- 业内首款深度融合**虎扑步行街文化**与**现代 MCN 带货商战**的轻量级策略模拟游戏。
- 相比传统挂机放置类模拟游戏，创新引入“15秒周末带货敏捷对战”，将反应手速（成单/打赏/踢黑粉/放绝技）与经营数值深度挂钩，形成独一无二的“数值规划 + 操作爽感”双核驱动。

## Operating Context

- **运行环境**: 移动端优先（适配 360px ~ 480px 宽度及各类刘海屏/全屏手势），兼顾桌面端浏览器。
- **宿主环境**: 虎扑 App 内嵌 WebView、各社交平台内置浏览器、iOS Safari、Android Chrome。
- **网络特性**: 默认离线即玩，网络异常时 100% 本地闭环，预留云端联调钩子。

## Capabilities and Constraints

- **核心闭环**: 12 周季度冲刺主线 + 通关后自由无尽模式（Endless Mode）。
- **多赛道主播矩阵**: 5 位特色门面（带货花旦苏晚晴、市井奇才强哥、全息数字人灵汐、法学教授罗老师、短剧战神赘婿龙王），包含体能、话术带货力、心理抗压度、忠诚度与专属绝技。
- **基建设施升级**: 专业级直播间（流水增益）、自建质检供应链（防退货/口碑回血）、舆情反商战雷达（免伤黑粉）。
- **15秒周末带货战**:
  - 动态掉落 4 类弹幕（绿色普通成单、金色榜一大哥打赏、红色水军黑粉、紫色爆单时刻）；
  - 连击数乘数递增、Fever 狂热状态、蓄力全屏大招；
  - 实时 GMV、粉丝转化与体力损耗结算。
- **商战与舆情决策**: 12 周每阶段 2~3 项极具现实映射与反转幽默的分支抉择，影响复仇度、黑马度与科技路线。
- **多维结局与评级**: 涵盖 SSS（9.9分商业GOAT）至 FAIL（1.8分破产清算）的多样化结算结局。
- **交互与触控约束**: 全面适配移动端触控，采用 `pointerup`/`touchend` 全局事件委托与时间戳防抖，拒绝系统原生阻塞弹窗与全局手势冲突。
- **音频安全性**: 原生 Web Audio 合成音效（金币、欢呼、警报、连击阶梯音），带静音开关与全链路 `try/catch` 零阻塞防护。

## Brand Commitments

- **视觉调性**: 虎扑经典竞技红（`#c91b1b`）为主色调，搭配深邃沉浸的体育场夜色（`#0b0f19` / `#131b2e`）与荣耀琥珀金（`#f59e0b`）。
- **语言风格**: 硬核、热血、幽默诙谐，地道融入步行街 JRs 语系（“这波什么水平”、“实战利器”、“绝杀时刻”、“步行街名宿”、“商业GOAT”）。

## Evidence on Hand

- 游戏详细策划方案：[`game_design_doc.md`](file:///C:/Users/admin/.gemini/antigravity/brain/31085ffc-eb7c-414f-854f-9e78dfbec444/game_design_doc.md)
- 交付级源码：[`d:\tools4\index.html`](file:///d:/tools4/index.html) 与 [`d:\tools4\mcn_agent.html`](file:///d:/tools4/mcn_agent.html)
- 实时预览工件：[`mcn_preview.html`](file:///C:/Users/admin/.gemini/antigravity/brain/31085ffc-eb7c-414f-854f-9e78dfbec444/mcn_preview.html)

## Product Principles

1. **瞬时响应（Zero Latency）**：移动端触控 0 延迟，操作即时反馈，杜绝任何外部依赖导致的加载白屏或手势卡顿。
2. **纯正 JRs 文化共鸣（Community-Driven）**：不搞生硬造梗，自然融入社区精神，提供有认同感的评分与打分体系。
3. **策略与手速双轨并重（Strategy Meets Action）**：既有长线主播与基建的深谋远虑，又有 15 秒敏捷带货的极限操作。
4. **安全与离线优先（Resilient by Default）**：不假设任何宿主网络或高级 API 权限，在最严苛的 WebView 沙箱中依然能 100% 稳定运行。
5. **规范化工程集成（Platform Ready）**：单文件自包含的同时规范接口层，满足虎扑 AI 工坊生产级交付标准。

## Accessibility & Inclusion

- 严格遵循 WCAG AA 移动端色彩对比度规范，保障夜间深色模式下的文字清晰可读。
- 所有交互按键热区不小于 44×44px，提供明确的按压微缩与 Toast 状态反馈。
- 音效作为增强属性，不作为关键游戏信息获取的唯一渠道；静音状态下具备完整视觉提示。
