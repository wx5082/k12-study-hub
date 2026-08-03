# GitHub Pages + Supabase 免费部署方案

如果 Cloudflare / Vercel / Render 都不好用，可以直接用 GitHub Pages。

部署后发给别人的地址通常是：

```text
https://wx5082.github.io/k12-study-hub/
```

## 1. Supabase 建表

打开 Supabase：

```text
SQL Editor -> New query
```

复制执行：

```text
learning-platform/supabase/schema.sql
```

## 2. 关闭邮箱确认

建议测试阶段关闭邮箱确认：

```text
Authentication -> Providers -> Email -> 关闭 Confirm email
```

否则注册后需要先去邮箱确认，再登录。

## 3. 添加 GitHub Secrets

打开 GitHub 仓库：

```text
https://github.com/wx5082/k12-study-hub
```

进入：

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

添加两个 Secret：

```text
SUPABASE_URL=你的 Supabase Project URL
SUPABASE_ANON_KEY=你的 Supabase anon public key
```

这两个值在 Supabase：

```text
Project Settings -> API
```

注意：这里不是数据库连接串，也不是数据库密码。

## 4. 开启 GitHub Pages

打开仓库：

```text
Settings -> Pages
```

Source 选择：

```text
GitHub Actions
```

保存。

## 5. 等待自动部署

推送代码后，GitHub 会自动运行：

```text
Deploy GitHub Pages
```

可以在仓库的：

```text
Actions
```

里查看进度。

成功后访问：

```text
https://wx5082.github.io/k12-study-hub/
```

## 6. 发给别人

普通使用：

```text
https://wx5082.github.io/k12-study-hub/
```

共享同一份学习数据：

```text
访问地址：https://wx5082.github.io/k12-study-hub/
共享码：页面里显示的 6 位共享码
```
