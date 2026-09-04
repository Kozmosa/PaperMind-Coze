# Expo App + Express.js

## 目录结构规范（严格遵循）

当前仓库是一个 monorepo（基于 pnpm 的 workspace）

- Expo 代码在 client 目录，Express.js 代码在 server 目录
- 底部导航采用 Tab Bar（对应下文「方案二」，已有 `(tabs)` 路由组）

```text
├── client/                     # React Native / Expo 前端
│   ├── app/                    # expo-router 路由目录（仅路由 re-export，实现见 screens/）
│   │   ├── _layout.tsx         # 根布局（Stack + AuthGuard，改动前务必阅读）
│   │   ├── (tabs)/             # 底部 Tab：index(chat) / knowledge / community / control-center / profile
│   │   └── *.tsx               # Stack 页面：ai-chat、reflection、knowledge-builder 等
│   ├── screens/                # 页面实现目录（与 app/ 路由一一对应）
│   ├── components/             # 可复用组件（Screen 页面容器等）
│   ├── hooks/                  # 自定义 Hooks
│   ├── contexts/               # React Context 代码
│   ├── utils/                  # 工具函数
│   ├── assets/                 # 静态资源
│   └── global.css              # 主题 design tokens（tailwindcss 入口）
├── server/                     # Express.js 后端
│   ├── src/
│   │   ├── index.ts            # 服务端入口（默认端口 9091）
│   │   ├── routes/             # ai、knowledge-*、materials 等 REST 路由
│   │   ├── middleware/         # Supabase Auth 鉴权
│   │   ├── storage/database/   # schema 定义 + Supabase 客户端
│   │   └── utils/              # 文本提取、向量索引
│   ├── scripts/                # 数据脚本（seed-scenario、seed-mvp1、reprocess-materials）
│   └── package.json
├── debug/                      # 浏览器调试页（后端静态挂载于 /debug/*）
├── docs/                       # 架构文档
├── test_data/                  # 本地测试数据（种子脚本读取）
├── .cozeproj  .coze            # 扣子平台脚手架与配置（禁止修改）
├── patches/                    # expo@54.0.33 HMR 补丁
└── package.json
```

## 样式方案

基于 tailwindcss 进行样式开发（底层基于 Uniwind）

写法示例：

```tsx
<View className="flex-1 bg-white dark:bg-gray-900 p-4"></View>
```

```tsx
<Text
  className="text-lg font-bold text-gray-900 dark:text-white"
  selectionColorClassName="accent-blue-500"
>
  Hello World
</Text>
```

Uniwind 官方文档：https://docs.uniwind.dev/llms.txt

## 如何进行静态校验（TSC + ESLint + Prettier）

```bash
# 全量校验(client lint + server lint + 格式检查),提交前必跑
pnpm -w validate

# 单独跑某一端
pnpm -w lint:client
pnpm -w lint:server

# 代码格式化(prettier,含 tailwind class 排序)
pnpm -w format

# 只检查格式不写入
pnpm -w format:check
```

## 如何修改主题模式（跟随系统、固定暗色、固定亮色）

默认为跟随系统，如果用户明确指定为“暗色”或“亮色”，需要修改 `client/components/ColorSchemeUpdater.tsx` 的 `DEFAULT_THEME` 变量为合适的值

## 如何定制主题 design tokens

当前项目的**设计系统**基于 tailwindcss 实现，核心入口文件为 `client/global.css`，如果需要定制主题，应该**阅读并修改 `client/global.css` 文件**

## 路由及 Tab Bar 实现规范

> 当前项目采用**方案二（Tabs）**。方案一仅作参考，除非明确要移除底部导航，否则不要新增 Stack-only 路由结构。

### 方案一：无 Tab Bar（Stack 导航）

适用于线性流程应用，采用简化的目录结构：

```
client/app/
├── _layout.tsx         # 根布局（Stack 导航配置）
├── index.tsx           # 应用入口
├── detail.tsx          # 详情页（通过 params 传递数据）
└── +not-found.tsx      # 404 页面
```

**根布局配置** `client/app/_layout.tsx`：

以下仅为代码片段供写法参考

```tsx
<Stack screenOptions={{ headerShown: false }}>
  <Stack.Screen name="index" />
  <Stack.Screen name="detail" />
</Stack>
```

**应用入口** `client/app/index.tsx`：

```tsx
export { default } from "@/screens/home";
```

> **禁止事项**：无 Tab Bar 场景下，不得创建 `(tabs)` 目录。

### 方案二：有 Tab Bar（Tabs 导航）

采用路由分组实现底部导航栏：

```
client/app/
├── _layout.tsx              # 根布局
├── (tabs)/
│   ├── _layout.tsx          # Tab 导航配置
│   ├── index.tsx            # 默认 Tab（必须存在）
│   ├── discover.tsx         # 发现页
│   └── profile.tsx          # 个人中心
├── detail.tsx               # Tab 外的独立页面（通过 params 传递数据）
└── +not-found.tsx
```

> **⚠️ [CRITICAL]**： `app/index.tsx` 优先级高于 `(tabs)/index.tsx`，会导致首页无 Tab Bar。**当有(tabs)/index.tsx时必须删除 `app/index.tsx`**。

**根布局配置** `client/app/_layout.tsx`：

以下仅为代码片段供写法参考

```tsx
<Stack screenOptions={{ headerShown: false }}>
  <Stack.Screen name="(tabs)" />
  <Stack.Screen name="detail" />
</Stack>
```

**应用入口** `client/app/(tabs)/index.tsx`：

```tsx
export { default } from "@/screens/home";
```

**Tab 布局配置** `client/app/(tabs)/_layout.tsx`：

```tsx
import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome6 } from '@expo/vector-icons';
import { useCSSVariable } from 'uniwind';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const [background, muted, accent, border] = useCSSVariable([
    '--color-background',
    '--color-muted',
    '--color-accent',
    '--color-border',
  ]) as string[];

  let tabBarStyle = {
    backgroundColor: background,
    borderTopWidth: 1,
    borderTopColor: border,
  };

  // 用于修复 Web 上高度异常的问题（这个 if 逻辑必须添加）
  if (Platform.OS === 'web') {
    tabBarStyle = {
      ...tabBarStyle,
      height: 'auto',
    }
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle,
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: muted,
      }}
    >
      {/* name 必须与文件名完全一致 */}
      <Tabs.Screen
        name="index"
        options={{
          title: '首页',
          tabBarIcon: ({ color }) => (
            <FontAwesome6 name="house" size={20} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: '发现',
          tabBarIcon: ({ color }) => (
            <FontAwesome6 name="compass" size={20} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color }) => (
            <FontAwesome6 name="user" size={20} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
```

**Tab 页面文件** `client/app/(tabs)/index.tsx`：

```tsx
export { default } from "@/screens/home";
```

### 注意事项

在改动 `client/app/_layout.tsx` 前，必须先阅读该文件，再进行修改操作

以下是需要保留的重要逻辑

- 保留 global.css 引入（tailwindcss 生效的关键）
- 保留 Provider 的使用

## 依赖管理与模块导入规范

### 依赖安装

**禁止**使用 `npm` 或 `yarn`，按目录区分安装命令：

| 目录      | 安装命令                     | 说明                             |
| --------- | ---------------------------- | -------------------------------- |
| `client/` | `npx expo install <package>` | Expo 会自动选择与 SDK 兼容的版本 |
| `server/` | `pnpm add <package>`         | 使用 pnpm 管理后端依赖           |

```bash
# client 目录（Expo 项目）
cd client && npx expo install expo-camera expo-image-picker

# server 目录（Express 项目）
cd server && pnpm add axios cors
```

**网络问题处理**：`npx expo install` 可能因网络原因失败，失败时重试 2 次，仍失败则改用 `pnpm add` 安装

## Expo 开发规范

### 路径别名

Expo 配置了 `@/` 路径别名指向 `client/` 目录：

```tsx
// 正确
import { Screen } from '@/components/Screen';

// 避免相对路径
import { Screen } from '../../../components/Screen';
```

## 本地开发

`pnpm dev`：首次启动或重启前后端服务（等价于扣子平台的 `coze dev`，两者执行同一份 `.cozeproj/scripts/dev_run.sh`，会先尝试杀掉占用端口的进程再启动）。

- Expo Web：<http://localhost:5001>；后端：<http://localhost:9091>（健康检查 `GET /api/v1/health`）
- 日志输出到 `logs/client.log` 与 `logs/server.log`
- 数据库迁移（凭据二选一：`SUPABASE_ACCESS_TOKEN` 个人访问令牌走 Management API，或 `SUPABASE_DB_URL` pg 直连，见 `.env.example`）：
  - 应用全部待执行迁移：`cd server && npx tsx scripts/apply-migrations.ts`（幂等，账本在 `schema_migrations`）
  - 基础表已手动建过的库可先登记再应用：`npx tsx scripts/apply-migrations.ts --mark 000_init.sql 000_init_missing_tables.sql`
  - 校验关键列：`cd server && npx tsx scripts/verify-migrations.ts`
- 种子 / 重处理脚本（需服务已启动；tsx 是 server 的依赖，在 server 目录下执行）：
  - 演示场景包（推荐，含社区/反思/会话等全套数据）：`cd server && npx tsx scripts/seed-scenario.ts`，说明见 `test_data/scenario/README.md`
  - MVP1 最小种子（仅纪要+资料）：`cd server && npx tsx scripts/seed-mvp1.ts`
  - 资料重处理：`cd server && npx tsx scripts/reprocess-materials.ts`
