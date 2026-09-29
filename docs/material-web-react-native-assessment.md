# Material Web 与 React Native 适用性结论

## 结论

`@material/web` 不适合作为 PaperMind 的跨端 React Native 基础组件库。本次首页重构采用 `react-native-paper` 实现 Material Design 3 风格，并保留 Expo Web 输出。

## 原因

1. Material Web 的组件是 Web Components，例如 `md-filled-button`、`md-dialog`、`md-tabs`。
2. React Native 的原生渲染树不是 DOM。iOS 与 Android 上没有 custom elements、Shadow DOM、CSS custom properties 和浏览器事件模型。
3. React Native Web 虽然会把部分 React Native 组件渲染成 DOM，但 Material Web 组件仍需要额外的 React 包装层、事件桥接、类型声明、主题桥接和样式兼容层，维护成本高。
4. Material Web 仓库当前声明处于 maintenance mode，等待新维护者；作为大规模重构的长期基础风险偏高。

## 替代方案

- `react-native-paper`：面向 React Native 的 Material Design 组件库，支持 iOS、Android 和 React Native Web，可与 Expo Router 共用。
- 项目内继续保留语义化 Material tokens，后续页面逐步迁移到同一套 tokens 和组件。

## 后续迁移策略

1. 首页和全局 Provider 先接入 `react-native-paper`。
2. 所有新组件必须基于 Material tokens 与 `react-native-paper` 原语实现。
3. 纯 Web 专用能力不引入 Material Web；如确有浏览器专属需求，应隔离在 `Platform.OS === 'web'` 分支中评审。
