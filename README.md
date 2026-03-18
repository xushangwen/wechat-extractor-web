# 微信公众号文章提取工具

给一个微信公众号文章链接 → 输出保留原文排版的 Markdown + 智能命名的图片。

## 功能

- **完整抓取**：Puppeteer 驱动，自动滚动触发懒加载，处理 `data-src`、轮播图、背景图
- **SVG 装饰过滤**：自动过滤微信 SVG 装饰元素（`mmbiz_svg`）和占位图
- **AI 图片分析**：Gemini 2.0 Flash 判断装饰/内容图，生成中文描述和英文文件名
- **排版保留**：文字与图片按原文顺序输出 Markdown，保留标题、粗体、段落结构

## 使用

```bash
# 安装依赖
npm install

# 提取文章
node index.js "https://mp.weixin.qq.com/s/xxxxx"
```

## 输出结构

```
文章标题/
├── article.md          # Markdown 文档
├── article_data.json   # 原始结构化数据
└── images/
    ├── hongyun_logo.png
    ├── award_ceremony.jpg
    └── ...
```

## 环境要求

- Node.js 18+
- Google Chrome（系统已安装）
- `GEMINI_API_KEY` 环境变量（用于图片分析，不设置则跳过分析）
