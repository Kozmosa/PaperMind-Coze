# server/scripts 脚本说明

| 脚本 | 用途 | 用法 |
|---|---|---|
| `apply-migrations.ts` | 迁移执行（事务内 + schema_migrations 账本，幂等） | `npx tsx scripts/apply-migrations.ts [文件名...]` |
| `verify-migrations.ts` | 校验关键列存在 + 查看迁移账本 | `npx tsx scripts/verify-migrations.ts` |
| `seed-scenario.ts` | 演示场景导入（期中复习周 · 小禾），可重入，`--light` 只灌轻数据 | `npx tsx scripts/seed-scenario.ts [--light]` |
| `seed-mvp1.ts` | MVP1 旧数据导入（数据源在 `test_data/legacy-mvp1/`） | `npx tsx scripts/seed-mvp1.ts` |
| `backup-guest-data.ts` | seed 前备份演示用户数据（seed 会清空该用户） | `npx tsx scripts/backup-guest-data.ts` |
| `e2e-check.ts` | 场景包 API 级端到端验证（对照 scenario/README.md 清单） | `npx tsx scripts/e2e-check.ts` |
| `reprocess-materials.ts` | 批量重新分析资料 | `npx tsx scripts/reprocess-materials.ts` |
| `test-problem-solving-insert.ts` | 「我明白了」写入链路回归测试（事务回滚） | `npx tsx scripts/test-problem-solving-insert.ts` |

## 凭据

- 迁移类（apply/verify）：`SUPABASE_ACCESS_TOKEN`（Management API，推荐）或 `SUPABASE_DB_URL`（pg 直连）
- 数据类（seed/backup/e2e）：走本地后端 HTTP（`http://localhost:9091`），需先启动服务；Supabase 凭据读 `.env` 的 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- 所有脚本统一从 `server/.env`（回退仓库根 `.env`）读取环境变量
