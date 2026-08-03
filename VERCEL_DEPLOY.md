# Vercel 免费部署方案（无需信用卡）

目标：把 `learning-platform/` 部署到 Vercel 免费 Hobby 计划，页面由 Vercel 静态托管，接口由 Vercel Serverless Functions 提供，数据保存到 Supabase PostgreSQL。

部署后发给别人的地址是：

```text
https://你的项目名.vercel.app
```

不要发 `localhost`、`127.0.0.1` 或本地 `.html` 文件地址。

## 1. 先确认代码结构

当前项目已适配 Vercel：

```text
learning-platform/
  api/                 # Vercel Serverless API
  lib/core.js          # 账号、同步、共享空间公共逻辑
  public/              # H5 静态页面
  package.json
```

`public/index.html` 会成为网站首页，`/api/register`、`/api/login`、`/api/sync` 等接口会自动成为 Vercel Functions。

## 2. 推送到 GitHub

```bash
cd /Users/ytwl/WorkBuddy/2026-08-03-10-55-06/learning-platform
git add -A
git commit -m "adapt k12 learning platform for vercel"
git branch -M main
git remote add origin https://github.com/你的用户名/k12-study-hub.git
git push -u origin main
```

如果已经绑定过 `origin`，只需要：

```bash
git add -A
git commit -m "adapt k12 learning platform for vercel"
git push
```

## 3. 在 Vercel 导入项目

1. 打开 https://vercel.com
2. 使用 GitHub 登录
3. 点击 **Add New... -> Project**
4. 选择 GitHub 仓库
5. 如果仓库根目录不是 `learning-platform`，在 **Root Directory** 里选择：

```text
learning-platform
```

6. Framework Preset 选择：

```text
Other
```

7. Build Command 留空或使用默认
8. Output Directory 留空

## 4. 配置环境变量

在 Vercel 项目设置里进入：

```text
Settings -> Environment Variables
```

添加：

```text
DATABASE_URL=你的 Supabase Pooler 连接串?pgbouncer=true
NODE_ENV=production
```

连接串格式：

```text
postgresql://postgres.ofynwsemlryjmgjbriha:<你的数据库密码>@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
```

注意：

- 不要把真实数据库密码写进代码或提交到 GitHub。
- 你之前已经在聊天里发过数据库密码，正式上线前建议到 Supabase 重置数据库密码。
- 环境变量添加后，如果项目已经部署过，需要重新 Deploy 一次。

## 5. 部署

点击 **Deploy**。

部署完成后，Vercel 会给一个地址：

```text
https://k12-study-hub.vercel.app
```

这个地址就是可以发给学生、家长、老师使用的公网 H5 地址。

## 6. 验证

1. 打开 Vercel 地址。
2. 注册账号 A。
3. 新增一条作业，确认页面能保存。
4. 在 Supabase Table Editor 里检查 `users` 表是否出现数据。
5. 账号 A 在“总览 -> 共享学习空间”点击 **创建共享空间**。
6. 复制页面显示的 6 位共享码。
7. 用另一个浏览器或手机注册账号 B。
8. 账号 B 输入共享码，点击 **加入共享空间**。
9. A/B 任意一端新增作业、错题、单词或古诗文，另一端刷新或等待约 10 秒后应能看到更新。

## 7. 发给别人

普通使用：

```text
访问地址：https://你的项目名.vercel.app
```

多人共享同一份学习数据：

```text
访问地址：https://你的项目名.vercel.app
共享码：页面里显示的 6 位共享码
```
