# Cloudflare Pages + Supabase 免费部署方案

这套方案不需要 Render / Vercel，也不需要信用卡：

```text
Cloudflare Pages 托管 H5
Supabase Auth 负责邮箱密码登录
Supabase Postgres 保存学习数据和共享空间
```

部署成功后，发给别人的是：

```text
https://你的项目名.pages.dev
```

## 1. Supabase 建表

打开 Supabase 项目，进入：

```text
SQL Editor -> New query
```

复制并执行：

```text
learning-platform/supabase/schema.sql
```

这个脚本会创建：

```text
profiles
spaces
space_members
join_space()
```

并开启 RLS 权限控制，保证用户只能访问自己的个人数据，或自己加入的共享学习空间。

## 2. Supabase 关闭邮箱确认

为了让家长/学生注册后能立刻登录，建议测试阶段关闭邮箱确认：

```text
Authentication -> Providers -> Email
关闭 Confirm email
```

如果保持开启，注册后需要先去邮箱点确认链接，再登录。

## 3. 获取 Supabase 前端配置

进入 Supabase：

```text
Project Settings -> API
```

复制两个值：

```text
Project URL
anon public key
```

注意：这里用的是 `anon public key`，不是数据库密码。数据库密码不要放进 Cloudflare 前端项目。

## 4. 推送代码到 GitHub

```bash
cd /Users/ytwl/WorkBuddy/2026-08-03-10-55-06/learning-platform
git add -A
git commit -m "adapt app for cloudflare pages and supabase"
git push
```

如果 `CLOUDFLARE_DEPLOY.md` 或 `supabase/schema.sql` 被全局规则忽略，可以强制添加：

```bash
git add -f CLOUDFLARE_DEPLOY.md supabase/schema.sql
```

## 5. 创建 Cloudflare Pages 项目

打开：

```text
https://dash.cloudflare.com
```

进入：

```text
Workers & Pages -> Create -> Pages -> Connect to Git
```

选择 GitHub 仓库：

```text
wx5082/k12-study-hub
```

如果仓库里项目在 `learning-platform` 目录，配置：

```text
Project name: k12-study-hub
Production branch: main
Framework preset: None
Root directory: learning-platform
Build command: npm run build
Build output directory: public
```

## 6. 配置 Cloudflare 环境变量

在 Pages 项目设置里进入：

```text
Settings -> Environment variables
```

添加：

```text
SUPABASE_URL=你的 Supabase Project URL
SUPABASE_ANON_KEY=你的 Supabase anon public key
```

保存后重新部署一次。

## 7. 验证

打开 Cloudflare 给你的地址：

```text
https://k12-study-hub.pages.dev
```

测试：

1. 用邮箱注册账号 A。
2. 新增作业，刷新页面后仍然存在。
3. 在“总览 -> 共享学习空间”点击“创建共享空间”。
4. 复制 6 位共享码。
5. 用另一个浏览器或手机注册账号 B。
6. 输入共享码，点击“加入共享空间”。
7. A/B 任意一端新增作业、错题、单词或古诗文，另一端刷新或等待约 10 秒后能看到更新。

## 8. 发给别人

普通使用只发：

```text
https://你的项目名.pages.dev
```

多人共享同一份学习数据时发：

```text
访问地址：https://你的项目名.pages.dev
共享码：页面显示的 6 位共享码
```
