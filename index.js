#!/usr/bin/env node
import 'dotenv/config';

import { scrapeArticle } from './lib/scraper.js';
import { downloadAllImages, analyzeImages, renameImages } from './lib/image-analyzer.js';
import { generateMarkdown } from './lib/markdown-generator.js';
import fs from 'fs/promises';
import path from 'path';

const url = process.argv[2];

if (!url) {
  console.log(`
╔══════════════════════════════════════════════════╗
║   微信公众号文章提取工具                           ║
║   提取文字 + 图片 + 排版 → Markdown               ║
╚══════════════════════════════════════════════════╝

用法: node index.js <微信文章链接>

示例:
  node index.js "https://mp.weixin.qq.com/s/xxxxx"

功能:
  • 完整抓取文章文字和图片（处理懒加载/轮播图）
  • AI 分析图片（过滤装饰元素、智能命名）
  • 保留原文排版输出 Markdown

环境变量:
  GEMINI_API_KEY  - Google Gemini API Key（用于图片分析）
`);
  process.exit(0);
}

// 从 URL 提取文章 ID 作为目录名
function getArticleId(articleUrl) {
  try {
    const urlObj = new URL(articleUrl);
    // 微信文章 URL 格式: /s/xxxxx 或含参数
    const pathMatch = urlObj.pathname.match(/\/s\/([^/?]+)/);
    if (pathMatch) return pathMatch[1].substring(0, 16);
    // 使用时间戳
    return `article_${Date.now()}`;
  } catch {
    return `article_${Date.now()}`;
  }
}

async function main() {
  const startTime = Date.now();
  console.log('');
  console.log('🚀 微信公众号文章提取工具');
  console.log('═'.repeat(50));
  console.log(`📎 URL: ${url}`);
  console.log('');

  // Step 1: 抓取文章
  console.log('━━━ Step 1/4: 抓取文章内容 ━━━');
  let articleData;
  try {
    articleData = await scrapeArticle(url);
  } catch (err) {
    console.error(`❌ 抓取失败: ${err.message}`);
    process.exit(1);
  }

  const imageCount = articleData.elements.filter(e => e.type === 'image').length;
  const bgCount = articleData.elements.filter(e => e.type === 'background_image').length;
  const galleryCount = articleData.elements.filter(e => e.type === 'gallery').length;
  const textCount = articleData.elements.filter(e => e.type === 'text').length;

  console.log(`  📰 标题: ${articleData.title}`);
  console.log(`  ✍️  作者: ${articleData.author}`);
  console.log(`  📝 文本段落: ${textCount}`);
  console.log(`  🖼️  内容图片: ${imageCount}`);
  console.log(`  🎨 背景图片: ${bgCount}`);
  console.log(`  📸 轮播图组: ${galleryCount}`);
  console.log('');

  // 创建输出目录
  const articleId = getArticleId(url);
  const sanitizedTitle = (articleData.title || articleId)
    .replace(/[/\\:*?"<>|]/g, '_')
    .substring(0, 60);
  const outputDir = path.join(process.cwd(), sanitizedTitle);
  await fs.mkdir(outputDir, { recursive: true });

  // Step 2: 下载图片
  console.log('━━━ Step 2/4: 下载图片 ━━━');
  const downloadedImages = await downloadAllImages(articleData.elements, outputDir);
  console.log(`  ✅ 成功下载 ${downloadedImages.length} 张图片`);
  console.log('');

  // Step 3: AI 分析图片
  console.log('━━━ Step 3/4: AI 分析图片 ━━━');
  const analyzedImages = await analyzeImages(downloadedImages, articleData.title);
  const contentImages = analyzedImages.filter(i => !i.isDecorative);
  const decorativeImages = analyzedImages.filter(i => i.isDecorative);
  console.log(`  📊 内容图片: ${contentImages.length} 张`);
  console.log(`  🎨 装饰图片: ${decorativeImages.length} 张（已标记删除）`);
  console.log('');

  // Step 4: 重命名 + 生成 Markdown
  console.log('━━━ Step 4/4: 生成 Markdown ━━━');
  const renamedImages = await renameImages(analyzedImages);
  const markdown = generateMarkdown(articleData, renamedImages);
  const mdPath = path.join(outputDir, 'article.md');
  await fs.writeFile(mdPath, markdown, 'utf-8');

  // 保存原始数据（便于调试）
  const dataPath = path.join(outputDir, 'article_data.json');
  await fs.writeFile(dataPath, JSON.stringify({
    url,
    ...articleData,
    analyzedImages: renamedImages.map(i => ({
      filename: i.finalFilename,
      description: i.description,
      src: i.src,
    })),
  }, null, 2), 'utf-8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('═'.repeat(50));
  console.log(`✅ 提取完成！耗时 ${elapsed}s`);
  console.log(`📁 输出目录: ${outputDir}`);
  console.log(`📄 Markdown: ${mdPath}`);
  console.log(`🖼️  保留图片: ${renamedImages.length} 张`);
  console.log('');
  console.log(`__OUTPUT__:${JSON.stringify({ dir: outputDir, title: articleData.title })}`);
}

main().catch(err => {
  console.error('❌ 发生错误:', err);
  process.exit(1);
});
