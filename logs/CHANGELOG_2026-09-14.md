# 变更日记 2026-09-14 — Vant 组件安卓原生复刻工程（APP/）

> 本次变更不涉及 api/ 后端代码；按 agent.md 约定在此留档，并同步 README 引用。

## 任务

1. 学习 `web/` 项目（Vue3 + Vant4 PWA）
2. 盘点项目用到的全部 Vant 组件
3. 在 `APP/` 新建安卓原生（Jetpack Compose）组件工程，一比一复刻，供后续原生 APP 重构调用
4. 不做的事：不重构 web 项目本身（未动 web/ 一行代码）

## 产出

### 组件盘点（45 类组件 + 7 类函数式 API）

- 扫描 `web/src` 全部 `.vue/.js`，统计标签使用次数与 props/slots/events（如 van-icon 413 次、van-cell-group 125 次、showToast 69 次、showConfirmDialog 28 次…）
- 清单文档：`APP/docs/vant-components-inventory.md`

### 复刻工程 `APP/`

```
APP/
├── settings.gradle.kts / build.gradle.kts / gradle.properties / wrapper(Gradle 8.7)
├── vant-ui/   # 组件库模块（com.live.vant）45 类组件全覆盖：
│   │          #   basic 14 + form 11 + feedback 7 + nav 5 + layout 1 + other 2
│   ├── theme/ # VantColors/VantDimens/VantTheme —— 默认值 = style.css 覆盖后的项目主题（primary #3a66e0 等）
│   └── res/font/vant_icon.ttf  # Vant 原版图标字体（从 vant/lib/index.css 内嵌 woff2 转 TTF），
│                                # VantIconCodes.kt 自动提取 259 个名称→码点映射，图标像素级一致
└── demo/      # 5 页演示 App：底部 tabbar 自身即 van-tabbar 复刻，覆盖全部组件
```

### 关键实现

- 图标：直接复用 Vant @font-face 字体 + 259 码点表（与 web 同一字形）
- 空状态插画：4 套内置 SVG（default/error/search/network）以 Path.parse 原样移植
- Picker：6×44px 滚轮 + 拖拽吸附 + 蒙层渐变 + 上下 hairline，与 Vant 视觉一致
- 数字键盘：default/custom 双主题（custom 跨行「完成」键、backspace 用 Vant 原版 SVG path）
- Calendar：月历滚动 + 单选/多选/区间 + 月份水印 + 确认按钮
- Toast：状态宿主 + CompositionLocal，对应 showToast/showSuccessToast/showLoadingToast/closeToast 全部语义

## 验证

- **全量类型检查 + 字节码生成通过（0 错误）**：使用 Kotlin 1.9.24 embeddable 编译器 + Compose Compiler 1.5.14 插件，
  针对 JetBrains Compose 1.6.10 桌面 JAR（API 与 Android compose-bom 2024.06.00 一致）+ 最小桩（Coil/activity/R）
  编译 `APP/` 全部 44 个 Kotlin 源文件，产出 509 个 class，无 error（验证脚本：temp/check_kotlin.py 与 kcheckI.log）
- 过程中修复的真实缺陷（编译器发现）：`LocalVantDimens` 漏 `.current`（16 处）、KDoc 中 `image/*` 提前闭合注释、
  `onPreFling` 参数类型 Velocity、Path.parse 跨平台兼容、TextStyle 非法 maxLines/overflow 参数、
  VanPopup/VanRowCol(gutter)/VanCollapse(border)/VanUploader(multiple) 参数未接通等
- 本机无 Android SDK，未执行 assembleDebug 打包 APK；版本矩阵导入 Android Studio 可直接构建

## 已知差异（详见 APP/README.md）

- Popup/Dialog/键盘/日历/预览走独立 Window；Dropdown 全屏遮罩简化为内联展开
- Toast/Dialog 由函数式调用改为状态提升（Composable 惯例）
- van-uploader before-read/after-read 压缩上传链路属业务逻辑，提供 onPick(List<Uri>) 回调对接
- web 端 `albums-o/computer-o/palette` 三个图标名本就不在 Vant 4.9.22 字体中，两端一致渲染为空
