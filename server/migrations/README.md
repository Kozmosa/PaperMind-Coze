# 数据库迁移说明

## 执行机制

迁移由 `server/scripts/apply-migrations.ts` 执行（`cd server && npx tsx scripts/apply-migrations.ts`）：

- 按**文件名字典序**依次应用本目录下全部 `.sql` 文件；每个迁移在单个事务内执行（迁移体 + 账本写入同提交）。
- 已应用的迁移记录在 `public.schema_migrations`（`filename` 主键），重复执行自动跳过，幂等。
- `npx tsx scripts/apply-migrations.ts --mark <file...>`：只登记不执行——用于基础表已由建库流程创建、迁移文件本身非幂等（如 `CREATE POLICY`）的场景。
- 也可以把单个 SQL 文件直接粘贴到 Supabase SQL Editor 执行（各文件头部注释均标注了此用法）；但这样不会写账本，之后跑 `apply-migrations.ts` 会重复执行（本目录所有迁移体都是 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`，重复执行安全）。

## 各文件角色与顺序

| 文件                               | 角色                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `000_init.sql`                     | 全量基线建表：所有表的 `CREATE TABLE IF NOT EXISTS` + RLS 启用。新库从零初始化跑这一份即可得到完整结构（含 study_notes / materials 的全部业务列）。                                                                                                                                                                                                                                                                           |
| `000_init_missing_tables.sql`      | 基线补丁：为「study_notes / materials 已手动建过、其余表缺失」的存量库补齐缺失表（注释明确说明这两张表已存在会自动跳过）。与 `000_init.sql` 并存的原因正是兼容这类半初始化库；AGENTS.md 给出的用法是先 `--mark 000_init.sql 000_init_missing_tables.sql` 登记，再应用其余迁移。                                                                                                                                               |
| `002_add_related_draft_ids.sql`    | 增量：`problem_solving_logs.related_draft_ids`（issue #6 Task 1，修复写入断裂）。                                                                                                                                                                                                                                                                                                                                             |
| `003_add_reflections_raw_text.sql` | 增量：`reflections.raw_text`（issue #6 Task 4，解析失败兜底保留原文）。                                                                                                                                                                                                                                                                                                                                                       |
| `004_add_process_status.sql`       | 增量：`materials.process_status` / `study_notes.process_status`（issue #7 Task 2，分类状态机 pending/processed/failed）。                                                                                                                                                                                                                                                                                                     |
| `add_papermind_fields.sql`         | 历史手动迁移（PaperMind MVP1 时期，要求在 SQL Editor 手动执行）：给 study_notes / materials 补 `logical_path` / `papercore` / `ai_processed` / `viewed_after_process` / `blocks`。**这些列已包含在 `000_init.sql` 的建表语句里**——对从零跑 `000_init.sql` 的新库它是纯 no-op；只有早于 `000_init.sql` 建表的存量库才真正需要它。文件名无数字前缀，字典序排在 `00x_` 系列之后最后执行，全部 `ADD COLUMN IF NOT EXISTS`，幂等。 |

## 注意

- **不要重命名或删除已有迁移文件**：`schema_migrations` 账本以文件名为主键，改名会被当作新迁移重复执行。
- 新增迁移：按 `00N_描述.sql` 命名（保证字典序=执行序），迁移体必须幂等（`IF NOT EXISTS`），并在文件头部注释说明用途。
- `add_papermind_fields.sql` 是历史遗留命名，保留原名是因为存量库账本中已有记录。
