import 'dotenv/config';
import express from 'express';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { fileURLToPath } from 'url';
import os from 'os';

import { scrapeArticle } from './lib/scraper.js';
import { downloadAllImages, analyzeImages, renameImages } from './lib/image-analyzer.js';
import { generateMarkdown } from './lib/markdown-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const tasks = new Map();

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, '');
}

function getOutputBaseDir() {
  // Vercel 环境只有 /tmp 可写，本地使用当前目录
  if (process.env.VERCEL === '1') return '/tmp';
  return __dirname;
}

function sanitizeTitle(title, fallback) {
  return (title || fallback)
    .replace(/[/\\:*?"<>|]/g, '_')
    .substring(0, 60);
}

app.get('/api/extract', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const taskId = Date.now().toString();

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  send('start', { taskId });

  // 拦截 console.log/warn/error 流式输出到 SSE
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  const patchConsole = () => {
    console.log = (...args) => {
      const msg = stripAnsi(args.join(' '));
      if (msg.trim()) send('log', { message: msg });
      origLog(...args);
    };
    console.warn = (...args) => {
      const msg = stripAnsi(args.join(' '));
      if (msg.trim()) send('log', { message: msg });
      origWarn(...args);
    };
    console.error = (...args) => {
      const msg = stripAnsi(args.join(' '));
      if (msg.trim()) send('log', { message: msg, isError: true });
      origError(...args);
    };
  };

  const restoreConsole = () => {
    console.log   = origLog;
    console.warn  = origWarn;
    console.error = origError;
  };

  let outputDir = null;
  let articleTitle = null;

  try {
    patchConsole();

    // Step 1: 抓取文章
    send('log', { message: '━━━ Step 1/4: 抓取文章内容 ━━━' });
    const articleData = await scrapeArticle(url);
    articleTitle = articleData.title;

    send('log', { message: `  📰 标题: ${articleData.title}` });
    send('log', { message: `  ✍️  作者: ${articleData.author}` });
    const textCount = articleData.elements.filter(e => e.type === 'text').length;
    const imageCount = articleData.elements.filter(e => ['image','gallery','background_image'].includes(e.type)).length;
    send('log', { message: `  📝 文本段落: ${textCount}，图片: ${imageCount}` });
    send('log', { message: '' });

    // 创建输出目录（Vercel 用 /tmp）
    const baseDir = getOutputBaseDir();
    const dirName = sanitizeTitle(articleData.title, `article_${taskId}`);
    outputDir = path.join(baseDir, dirName);
    await fsPromises.mkdir(outputDir, { recursive: true });

    // Step 2: 下载图片
    send('log', { message: '━━━ Step 2/4: 下载图片 ━━━' });
    const downloadedImages = await downloadAllImages(articleData.elements, outputDir);
    send('log', { message: `  ✅ 成功下载 ${downloadedImages.length} 张图片` });
    send('log', { message: '' });

    // Step 3: AI 分析图片
    send('log', { message: '━━━ Step 3/4: AI 分析图片 ━━━' });
    const analyzedImages = await analyzeImages(downloadedImages, articleData.title);
    const contentCount = analyzedImages.filter(i => !i.isDecorative).length;
    const decorCount   = analyzedImages.filter(i => i.isDecorative).length;
    send('log', { message: `  📊 内容图片: ${contentCount} 张，装饰图片: ${decorCount} 张` });
    send('log', { message: '' });

    // Step 4: 重命名 + 生成 Markdown
    send('log', { message: '━━━ Step 4/4: 生成 Markdown ━━━' });
    const renamedImages = await renameImages(analyzedImages);
    const markdown = generateMarkdown(articleData, renamedImages);
    const mdPath = path.join(outputDir, 'article.md');
    await fsPromises.writeFile(mdPath, markdown, 'utf-8');

    send('log', { message: `  ✅ Markdown 已生成` });

    tasks.set(taskId, { outputDir, title: articleTitle });

    send('complete', {
      taskId,
      title: articleTitle,
      downloadUrl: `/api/download/${taskId}`,
    });
  } catch (err) {
    send('error', { message: `提取失败: ${err.message}` });
    origError('提取错误:', err);
  } finally {
    restoreConsole();
    res.end();
  }
});

app.get('/api/download/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);

  if (!task) {
    return res.status(404).json({ error: '任务不存在或已过期，请重新提取' });
  }

  const { outputDir } = task;

  if (!fs.existsSync(outputDir)) {
    return res.status(404).json({ error: '输出目录不存在' });
  }

  const dirName = path.basename(outputDir);
  const zipName = `${dirName}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => { console.error('打包错误:', err); });
  archive.pipe(res);
  archive.directory(outputDir, dirName);
  archive.finalize();
});

// 本地开发环境
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`\n🚀 微信文章提取器已启动`);
    console.log(`   访问: http://localhost:${PORT}\n`);
  });
}

export default app;
