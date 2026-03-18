import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';

/**
 * 下载图片（ESM 兼容，使用 fetch）
 */
export async function downloadImageFetch(url, destPath) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Referer': 'https://mp.weixin.qq.com/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // 检测下载内容是否为 SVG 占位图（微信某些图片URL实际返回SVG）
  const head = buffer.slice(0, 100).toString('utf-8');
  if (head.includes('<?xml') || head.includes('<svg')) {
    throw new Error('下载到的是 SVG 占位图，跳过');
  }

  // 检测文件是否过小（< 500B 基本是占位符）
  if (buffer.length < 500) {
    throw new Error(`文件过小 (${buffer.length}B)，可能是占位图`);
  }

  await fs.writeFile(destPath, buffer);
  return destPath;
}

/**
 * 批量下载文章中的所有图片
 */
export async function downloadAllImages(elements, outputDir) {
  const imagesDir = path.join(outputDir, 'images');
  await fs.mkdir(imagesDir, { recursive: true });

  const downloadTasks = [];

  for (const el of elements) {
    if (el.type === 'image') {
      const ext = guessExtension(el.src, el.dataType);
      const filename = `img_${String(el.index).padStart(3, '0')}.${ext}`;
      const destPath = path.join(imagesDir, filename);
      downloadTasks.push({
        element: el,
        filename,
        destPath,
        src: el.src,
      });
    } else if (el.type === 'gallery') {
      for (let i = 0; i < el.images.length; i++) {
        const img = el.images[i];
        const ext = guessExtension(img.src, '');
        const filename = `gallery_${String(el.index).padStart(3, '0')}_${i}.${ext}`;
        const destPath = path.join(imagesDir, filename);
        downloadTasks.push({
          element: img,
          filename,
          destPath,
          src: img.src,
          galleryIndex: el.index,
          galleryImageIndex: i,
        });
      }
    } else if (el.type === 'background_image') {
      const ext = guessExtension(el.src, '');
      const filename = `bg_${String(el.index).padStart(3, '0')}.${ext}`;
      const destPath = path.join(imagesDir, filename);
      downloadTasks.push({
        element: el,
        filename,
        destPath,
        src: el.src,
        isBackground: true,
      });
    }
  }

  console.log(`📥 开始下载 ${downloadTasks.length} 张图片...`);

  // 并发下载，限制并发数
  const concurrency = 5;
  const results = [];
  for (let i = 0; i < downloadTasks.length; i += concurrency) {
    const batch = downloadTasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (task) => {
        try {
          await downloadImageFetch(task.src, task.destPath);
          console.log(`  ✅ ${task.filename}`);
          return { ...task, success: true };
        } catch (err) {
          console.log(`  ❌ ${task.filename}: ${err.message}`);
          return { ...task, success: false, error: err.message };
        }
      })
    );
    results.push(...batchResults.map(r => r.value || r.reason));
  }

  return results.filter(r => r && r.success);
}

/**
 * 使用 Gemini 分析图片：判断装饰/内容 + 智能命名
 */
export async function analyzeImages(downloadedImages, articleTitle) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.log('⚠️  未设置 GEMINI_API_KEY，跳过图片分析');
    return downloadedImages.map(img => ({
      ...img,
      isDecorative: false,
      description: '',
      suggestedName: img.filename,
    }));
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });

  console.log(`🤖 正在用 Gemini 分析 ${downloadedImages.length} 张图片...`);

  // 预处理：GIF 动图直接标记为装饰图（通常是分割线、动态图标等）
  const processedImages = downloadedImages.map(img => {
    const ext = path.extname(img.destPath).toLowerCase();
    if (ext === '.gif') {
      console.log(`  🎬 GIF 动图自动标记为装饰: ${img.filename}`);
      return {
        ...img,
        isDecorative: true,
        description: 'GIF动图（自动过滤）',
        suggestedName: img.filename.replace(/\.[^.]+$/, ''),
        skipAI: true,
      };
    }
    return img;
  });

  // 只对非 GIF 图片进行 AI 分析
  const imagesToAnalyze = processedImages.filter(img => !img.skipAI);
  if (imagesToAnalyze.length === 0) {
    console.log('  ℹ️  所有图片均已预处理，跳过 AI 分析');
    return processedImages;
  }

  console.log(`  📊 需要 AI 分析: ${imagesToAnalyze.length} 张（已跳过 ${processedImages.length - imagesToAnalyze.length} 张 GIF）`);

  // 批量分析，每批最多 10 张
  const batchSize = 10;
  const allResults = [];

  for (let i = 0; i < imagesToAnalyze.length; i += batchSize) {
    const batch = imagesToAnalyze.slice(i, i + batchSize);
    const batchResults = await analyzeBatch(model, batch, articleTitle);
    allResults.push(...batchResults);
    // 避免触发 API 限流
    if (i + batchSize < imagesToAnalyze.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 合并预处理结果和 AI 分析结果
  const gifImages = processedImages.filter(img => img.skipAI);
  return [...gifImages, ...allResults];
}

/**
 * 构建 Gemini 分析 prompt（包含上下文）
 */
function buildAnalysisPrompt(articleTitle, imagesWithContext) {
  let contextInfo = '';
  
  // 为每张图片添加上下文信息
  imagesWithContext.forEach((img, idx) => {
    if (img.context) {
      const ctx = img.context;
      let ctxText = `\n图片 ${idx}`;
      if (ctx.caption) ctxText += `\n  图片说明：${ctx.caption}`;
      if (ctx.before) ctxText += `\n  前文：${ctx.before.substring(0, 150)}`;
      if (ctx.after) ctxText += `\n  后文：${ctx.after.substring(0, 150)}`;
      if (ctxText.length > 10) contextInfo += ctxText + '\n';
    }
  });

  return `你是专业的图片内容分析助手。以下是微信公众号文章「${articleTitle}」中的图片。

${contextInfo ? '**图片上下文信息**：' + contextInfo : ''}

请严格判断每张图片的类型：

**装饰性元素（decorative）** - 必须标记为 decorative 的情况：
- 分割线、边框、背景纹理、渐变色块
- 小图标（如箭头、星星、勾选标记）
- 二维码、公众号名片
- 纯文字图片（如标题卡片、引用框）
- Logo、水印、品牌标识
- 装饰性几何图形、线条
- 空白占位图

**正文内容图片（content）** - 标记为 content 的情况：
- 产品照片、人物照片、场景照片
- 数据图表、流程图、示意图
- 截图（包含实质性信息）
- 信息图、海报（包含关键信息）

**描述要求**：
- 如果有图片说明文字，优先使用原文说明
- 如果有上下文，结合上下文生成准确描述
- 描述要简洁、准确，符合文章内容
- 避免泛泛而谈，要具体描述图片内容

**判断原则**：
- 如果删除该图片会导致文章信息缺失 → content
- 如果删除该图片不影响文章理解 → decorative
- 有疑问时，倾向于标记为 decorative

请以 JSON 数组格式返回，每个元素包含：
{ "index": 图片序号, "type": "decorative"|"content", "description": "简短准确的描述（优先使用原文说明）", "suggestedName": "英文文件名" }

只返回 JSON 数组，不要其他内容。`;
}

/**
 * 读取图片为 base64，验证有效性
 */
async function readImageForGemini(img) {
  try {
    const stat = await fs.stat(img.destPath);
    // 跳过过小（< 100B，可能是空文件）或过大（> 20MB）的图片
    if (stat.size < 100 || stat.size > 20 * 1024 * 1024) return null;

    const imageData = await fs.readFile(img.destPath);
    const mimeType = getMimeType(img.destPath);

    // Gemini 支持的图片类型
    const supportedMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!supportedMimes.includes(mimeType)) return null;

    return {
      mimeType,
      data: imageData.toString('base64'),
    };
  } catch {
    return null;
  }
}

/**
 * 解析 Gemini 返回的 JSON
 */
function parseGeminiResponse(text) {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  return null;
}

/**
 * 单张图片分析（批量失败时的回退方案）
 */
async function analyzeSingle(model, img, articleTitle) {
  const imgData = await readImageForGemini(img);
  if (!imgData) {
    return { ...img, isDecorative: img.isBackground || false, description: '', suggestedName: img.filename.replace(/\.[^.]+$/, '') };
  }

  try {
    const result = await model.generateContent([
      { text: buildAnalysisPrompt(articleTitle, [img]) },
      { text: `\n图片 0 (文件: ${img.filename}):` },
      { inlineData: imgData },
    ]);
    const analyses = parseGeminiResponse(result.response.text());
    if (analyses && analyses[0]) {
      const a = analyses[0];
      return {
        ...img,
        isDecorative: a.type === 'decorative',
        description: a.description || '',
        suggestedName: a.suggestedName || img.filename.replace(/\.[^.]+$/, ''),
      };
    }
  } catch (err) {
    console.log(`    ⚠️  单张分析失败 ${img.filename}: ${err.message.substring(0, 60)}`);
  }

  return { ...img, isDecorative: img.isBackground || false, description: '', suggestedName: img.filename.replace(/\.[^.]+$/, '') };
}

/**
 * 批量分析一组图片，失败时逐张重试
 */
async function analyzeBatch(model, images, articleTitle) {
  // 预读取所有图片，过滤无效的
  const validImages = [];
  const invalidImages = [];

  for (const img of images) {
    const data = await readImageForGemini(img);
    if (data) {
      validImages.push({ img, data });
    } else {
      invalidImages.push(img);
    }
  }

  // 无效图片直接返回默认值
  const invalidResults = invalidImages.map(img => ({
    ...img,
    isDecorative: img.isBackground || false,
    description: '',
    suggestedName: img.filename.replace(/\.[^.]+$/, ''),
  }));

  if (validImages.length === 0) return invalidResults;

  // 构建批量请求（传入图片上下文）
  const parts = [{ text: buildAnalysisPrompt(articleTitle, images) }];
  for (let i = 0; i < validImages.length; i++) {
    const { img, data } = validImages[i];
    parts.push({ text: `\n图片 ${i} (文件: ${img.filename}):` });
    parts.push({ inlineData: data });
  }

  try {
    const result = await model.generateContent(parts);
    const analyses = parseGeminiResponse(result.response.text());
    if (analyses) {
      const validResults = validImages.map(({ img }, i) => {
        const a = analyses[i] || {};
        return {
          ...img,
          isDecorative: a.type === 'decorative',
          description: a.description || '',
          suggestedName: a.suggestedName || img.filename.replace(/\.[^.]+$/, ''),
        };
      });
      return [...validResults, ...invalidResults];
    }
  } catch (err) {
    console.log(`  ⚠️  批量分析失败，改为逐张分析: ${err.message.substring(0, 60)}`);
  }

  // 批量失败 → 逐张分析
  const fallbackResults = [];
  for (const { img } of validImages) {
    const result = await analyzeSingle(model, img, articleTitle);
    fallbackResults.push(result);
    await new Promise(r => setTimeout(r, 300)); // 限流
  }

  return [...fallbackResults, ...invalidResults];
}

/**
 * 重命名图片文件
 */
export async function renameImages(analyzedImages) {
  const renamed = [];
  const usedNames = new Set();

  for (const img of analyzedImages) {
    if (img.isDecorative) {
      // 删除装饰性图片
      try {
        await fs.unlink(img.destPath);
        console.log(`  🗑️  删除装饰图: ${img.filename} (${img.description})`);
      } catch {}
      continue;
    }

    // 生成唯一文件名
    let baseName = img.suggestedName || img.filename.replace(/\.[^.]+$/, '');
    baseName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    const ext = path.extname(img.destPath) || '.png';

    let finalName = `${baseName}${ext}`;
    let counter = 1;
    while (usedNames.has(finalName)) {
      finalName = `${baseName}_${counter}${ext}`;
      counter++;
    }
    usedNames.add(finalName);

    const newPath = path.join(path.dirname(img.destPath), finalName);
    try {
      await fs.rename(img.destPath, newPath);
      console.log(`  📝 ${img.filename} → ${finalName} (${img.description})`);
    } catch {
      // 重命名失败，保持原名
      finalName = img.filename;
    }

    renamed.push({
      ...img,
      finalFilename: finalName,
      finalPath: newPath,
    });
  }

  return renamed;
}

function guessExtension(url, dataType) {
  if (dataType === 'png') return 'png';
  if (dataType === 'jpeg' || dataType === 'jpg') return 'jpg';
  if (dataType === 'gif') return 'gif';
  if (dataType === 'webp') return 'webp';

  if (url.includes('wx_fmt=png') || url.includes('_png')) return 'png';
  if (url.includes('wx_fmt=jpeg') || url.includes('_jpg') || url.includes('_jpeg')) return 'jpg';
  if (url.includes('wx_fmt=gif') || url.includes('_gif')) return 'gif';
  if (url.includes('wx_fmt=webp')) return 'webp';

  return 'png'; // 默认 png
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  return mimeTypes[ext] || 'image/png';
}
