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

  // 遍历内容元素
  for (const el of elements) {
    switch (el.type) {
      case 'text': {
        const text = el.content.trim();
        if (!text) break;
        if (el.bold) {
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
          // 装饰图已被过滤，只输出内容图片
          const desc = imgInfo.description || el.alt || '图片';
          lines.push('');
          lines.push(`![${desc}](images/${imgInfo.finalFilename})`);
          lines.push('');
        }
        break;
      }

      case 'gallery': {
        lines.push('');
        lines.push('<!-- 轮播图组 -->');
        if (el.images) {
          for (const gImg of el.images) {
            const imgInfo = imageMap.get(gImg.src);
            if (imgInfo) {
              const desc = imgInfo.description || '轮播图';
              lines.push(`![${desc}](images/${imgInfo.finalFilename})`);
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
          lines.push('');
          lines.push(`![${imgInfo.description || '背景图'}](images/${imgInfo.finalFilename})`);
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
