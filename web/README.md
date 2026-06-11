# web — 学习笔记前端

把仓库根目录 `docs/research/` 下的 markdown 渲染成一个 Anthropic 风格的笔记站。

## 本地开发

```bash
cd web
npm install
npm run dev
```

打开 http://localhost:3004。

笔记内容直接读取 `../docs/research/` 下的文件,无需复制——改 markdown,刷新即可。

## 构建

```bash
npm run build
npm run start
```

## Vercel 部署

仓库根不是 Next.js 项目,前端在 `web/` 子目录,部署时需要把 **Root Directory** 设置成 `web`:

1. New Project → Import 这个仓库
2. **Root Directory**: `web`
3. Framework Preset: 自动识别为 Next.js
4. Build Command / Output 用默认即可
5. Deploy

> 因为 `lib/notes.ts` 会读取 `../docs/research`(也就是仓库根的 docs 目录),Vercel 默认 checkout 整个仓库,这条路径在构建时是可访问的。

## 目录

```
web/
  app/
    page.tsx               # 首页
    notes/
      page.tsx             # 笔记索引
      [...slug]/page.tsx   # markdown 渲染路由
    layout.tsx             # 全站 shell
    globals.css            # 设计 tokens
  lib/
    notes.ts               # 笔记 manifest(扫描 ../docs/research)
    markdown.ts            # remark/rehype 渲染管道
```

## 设计

警告:不要把样式改成"通用站点 + Tailwind"。这里刻意走 CSS Modules + serif 排版 + 暖橙色强调,
为的是和 Anthropic 博客一致的"warm minimalism"调子。详见仓库
`/Users/rain/.claude/commands/front-end-design-in-anthropic-style/SKILL.md`(本地)。
