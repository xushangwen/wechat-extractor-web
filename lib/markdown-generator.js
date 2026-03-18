import path from 'path';

/**
 * 将提取的文章结构转换为 Markdown
 * @param {object} articleData - 文章数据（title, author, publishTime, elements）
 * @param {Array} analyzedImages - 经过 Gemini 分析和重命名后的图片列表
 * @returns {string} Markdown 内容
 */
export function generateMarkdown(articleData, analyzedImages) {
  const { title, author, publishTime, elements } = articleData;

  // 建立图片索引映射：原始 src → 最终文件信息
  const imageMap = new Map();
  for (const img of analyzedImages) {
    imageMap.set(img.src, img);
  }

  // ─── 预处理：识别元素流中的图片注释 ──────────────────────────────
  // 规则：图片元素之后（跳过 paragraph_break/break），如果紧跟一个
  //       短文本（≤50字符），且该图片是内容图（在 imageMap 中），
  //       则将该文本标记为此图片的注释，不再独立渲染为段落。
  const captionByImageIdx = new Map(); // imageElementIndex → captionText
  const captionTextIndices = new Set(); // 已被标记为注释的 text 元素下标

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.type !== 'image' && el.type !== 'gallery') continue;

    // 只处理确实会在 markdown 中输出的图片
    const isVisible = el.type === 'image'
      ? imageMap.has(el.src)
      : el.images?.some(g => imageMap.has(g.src));
    if (!isVisible) continue;

    // 向后找到第一个非 break 元素
    let j = i + 1;
    while (j < elements.length
      && (elements[j].type === 'paragraph_break' || elements[j].type === 'break')) {
      j++;
    }

    if (j < elements.length && elements[j].type === 'text') {
      const text = elements[j].content.trim();
      // 排除章节标题（PART.01 / 第一章 / 1. 等）不应被误标为注释
      const chapterPattern = /^(PART|Part|part|第[一二三四五六七八九十\d]+章|\d+\.|Chapter)\s*[\d一二三四五六七八九十]+/;
      // 注释判断：非空、≤50字符、不是章节标题
      if (text.length > 0 && text.length <= 50 && !chapterPattern.test(text)) {
        captionByImageIdx.set(i, text);
        captionTextIndices.add(j);
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────

  const lines = [];

  // 文章标题
  if (title) {
    lines.push(`# ${title}`);
    lines.push('');
  }

  // 元信息
  const metaParts = [];
  if (author) metaParts.push(`**作者**: ${author}`);
  if (publishTime) metaParts.push(`**发布时间**: ${publishTime}`);
  if (metaParts.length > 0) {
    lines.push(`> ${metaParts.join(' | ')}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // 遍历内容元素（使用索引循环，便于查找注释）
  for (let idx = 0; idx < elements.length; idx++) {
    const el = elements[idx];

    // 跳过已被标记为图片注释的 text 元素
    if (captionTextIndices.has(idx)) continue;

    switch (el.type) {
      case 'text': {
        const text = el.content.trim();
        if (!text) break;

        // 检测章节标题模式（PART 01, Part 02, 第一章 等）
        const chapterPattern = /^(PART|Part|part|第[一二三四五六七八九十\d]+章|\d+\.|Chapter)\s*[\d一二三四五六七八九十]+/;
        if (chapterPattern.test(text)) {
          lines.push('');
          lines.push(`## ${text}`);
          lines.push('');
        } else if (el.bold) {
          lines.push(`**${text}**`);
        } else {
          lines.push(text);
        }
        break;
      }

      case 'heading': {
        const prefix = '#'.repeat(Math.min(el.level + 1, 6)); // 文章标题已用 h1
        lines.push('');
        lines.push(`${prefix} ${el.content}`);
        lines.push('');
        break;
      }

      case 'image': {
        const imgInfo = imageMap.get(el.src);
        if (imgInfo) {
          // 注释优先级：DOM 提取 > 元素流短文本 > Gemini AI 描述
          const domCaption = el.context?.caption || '';
          const streamCaption = captionByImageIdx.get(idx) || '';
          const caption = domCaption || streamCaption || imgInfo.description || el.alt || '';

          lines.push('');
          lines.push(`![${caption || '图片'}](images/${imgInfo.finalFilename})`);
          if (caption) {
            lines.push(`<sub>${caption}</sub>`);
          }
          lines.push('');
        }
        break;
      }

      case 'gallery': {
        lines.push('');
        lines.push('<!-- 轮播图组 -->');
        if (el.images) {
          const galleryStreamCaption = captionByImageIdx.get(idx) || '';
          for (const gImg of el.images) {
            const imgInfo = imageMap.get(gImg.src);
            if (imgInfo) {
              const caption = imgInfo.description || galleryStreamCaption || '轮播图';
              lines.push(`![${caption}](images/${imgInfo.finalFilename})`);
              if (caption && caption !== '轮播图') {
                lines.push(`<sub>${caption}</sub>`);
              }
            }
          }
        }
        lines.push('');
        break;
      }

      case 'background_image': {
        // 背景图通常是装饰性的，已被 Gemini 过滤
        const imgInfo = imageMap.get(el.src);
        if (imgInfo && !imgInfo.isDecorative) {
          const caption = el.context?.caption || imgInfo.description || '背景图';
          lines.push('');
          lines.push(`![${caption}](images/${imgInfo.finalFilename})`);
          if (caption && caption !== '背景图') {
            lines.push(`<sub>${caption}</sub>`);
          }
          lines.push('');
        }
        break;
      }

      case 'paragraph_break': {
        // 避免连续空行
        const lastLine = lines[lines.length - 1];
        if (lastLine !== '' && lastLine !== undefined) {
          lines.push('');
        }
        break;
      }

      case 'break': {
        lines.push('');
        break;
      }

      case 'list_item': {
        lines.push(`- ${el.content}`);
        break;
      }

      default:
        break;
    }
  }

  // 清理多余的连续空行（最多保留一个空行）
  let markdown = lines.join('\n');
  markdown = markdown.replace(/\n{3,}/g, '\n\n');
  markdown = markdown.trim() + '\n';

  return markdown;
}
