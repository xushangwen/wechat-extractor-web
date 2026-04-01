import * as cheerio from 'cheerio';

/**
 * 微信公众号文章抓取器
 * Vercel 环境: fetch + cheerio（无浏览器依赖，彻底解决 libnss3 问题）
 * 本地环境:   Puppeteer + 系统 Chrome
 */
export async function scrapeArticle(url) {
  if (process.env.VERCEL === '1') {
    return scrapeWithFetch(url);
  }
  return scrapeWithPuppeteer(url);
}

// ─── Vercel 路径：fetch + cheerio ────────────────────────────────────────────

async function scrapeWithFetch(url) {
  console.log('📖 正在获取文章...');

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://mp.weixin.qq.com/',
    },
    redirect: 'follow',
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const html = await response.text();
  const $ = cheerio.load(html);

  const title = $('#activity-name').text().trim() || $('h2.rich_media_title').text().trim();
  const author = $('#js_name').text().trim();
  const publishTime = $('#publish_time').text().trim();
  const contentEl = $('#js_content')[0];

  if (!contentEl) throw new Error('未找到文章内容，URL 可能无效或已过期');

  console.log('📝 正在提取文章结构...');

  const elements = [];
  let imageIndex = 0;

  // ── 工具函数 ──────────────────────────────────────────────────────────────

  function getAttr(node, attr) { return node.attribs?.[attr] || ''; }
  function getClass(node) { return node.attribs?.class || ''; }
  function getId(node) { return node.attribs?.id || ''; }
  function getStyle(node) { return node.attribs?.style || ''; }
  function getNodeText(node) { return $(node).text().trim(); }

  function isHidden(node) {
    return /display\s*:\s*none/i.test(getStyle(node));
  }

  function isLikelyDecorative(node) {
    const w = parseInt(getAttr(node, 'data-w') || '0');
    const h = parseInt(getAttr(node, 'data-h') || '0');
    const src = getAttr(node, 'data-src') || getAttr(node, 'src');
    if (w > 0 && w < 30) return true;
    if (h > 0 && h < 30) return true;
    if (!src) return true;
    if (src.includes('mmbiz_svg')) return true;
    if (src.startsWith('data:image/svg+xml')) return true;
    return false;
  }

  function isGalleryContainer(node) {
    const cls = getClass(node);
    return cls.includes('swiper') || cls.includes('album') ||
           cls.includes('wx_pic_swiper') || cls.includes('js_img_swiper');
  }

  function getNextEl(node) {
    let n = node.next;
    while (n && n.type !== 'tag') n = n.next;
    return n || null;
  }

  function getPrevEl(node) {
    let p = node.prev;
    while (p && p.type !== 'tag') p = p.prev;
    return p || null;
  }

  function nodeHasImg(node) {
    if (!node) return false;
    if (node.name === 'img') return true;
    return (node.children || []).some(nodeHasImg);
  }

  function countChildSections(node) {
    let n = 0;
    for (const c of (node.children || [])) {
      if (c.name === 'section') n++;
      n += countChildSections(c);
    }
    return n;
  }

  // ── 提取图片注释上下文 ────────────────────────────────────────────────────

  function extractImageContext(imgNode) {
    const context = { before: '', after: '', caption: '' };
    const alt = getAttr(imgNode, 'alt');
    if (alt.trim()) context.caption = alt.trim().substring(0, 100);

    let ancestor = imgNode.parent;
    let depth = 0;
    while (ancestor && ancestor !== contentEl && depth < 8) {
      const cls = getClass(ancestor);
      if (cls.includes('img_desc') || cls.includes('img-desc') || cls.includes('caption')) {
        const text = getNodeText(ancestor);
        if (text && text.length < 150) { context.caption = text; break; }
      }
      const nextSib = getNextEl(ancestor);
      if (nextSib && !nodeHasImg(nextSib)) {
        const text = getNodeText(nextSib);
        if (text && text.length > 0 && text.length <= 80 && countChildSections(nextSib) < 3) {
          context.caption = text; break;
        }
      }
      ancestor = ancestor.parent;
      depth++;
    }

    let topAncestor = imgNode.parent;
    while (topAncestor && topAncestor.parent && topAncestor.parent !== contentEl) {
      topAncestor = topAncestor.parent;
    }
    if (topAncestor) {
      const prev = getPrevEl(topAncestor);
      const next = getNextEl(topAncestor);
      if (prev && !nodeHasImg(prev)) context.before = getNodeText(prev).substring(0, 150);
      if (next && !nodeHasImg(next)) context.after = getNodeText(next).substring(0, 150);
    }

    return context;
  }

  // ── DOM 遍历，提取结构化内容 ──────────────────────────────────────────────

  function walkDOM(node, depth = 0) {
    if (!node) return;

    if (node.type === 'tag') {
      const tag = node.name;
      const cls = getClass(node);
      const id = getId(node);

      if (isHidden(node) && !isGalleryContainer(node)) return;
      if (id === 'js_profile_qrcode' || id === 'js_tags' ||
          cls.includes('reward') || cls.includes('qr_code') ||
          cls.includes('rich_media_tool') || cls.includes('function_mod')) return;

      // 图片
      if (tag === 'img') {
        const dataSrc = getAttr(node, 'data-src');
        const dataOriginalSrc = getAttr(node, 'data-original-src');
        const dataWSrc = getAttr(node, 'data-w-src');
        const rawSrc = getAttr(node, 'src');

        let src = '';
        if (dataSrc.startsWith('http')) src = dataSrc;
        else if (dataOriginalSrc.startsWith('http')) src = dataOriginalSrc;
        else if (dataWSrc.startsWith('http')) src = dataWSrc;
        else if (rawSrc.startsWith('http')) src = rawSrc;

        if (src) src = src.split('#')[0];
        if (!src || isLikelyDecorative(node)) return;
        if (src.startsWith('data:image/svg+xml')) return;

        elements.push({
          type: 'image',
          src,
          width: parseInt(getAttr(node, 'data-w') || '0'),
          height: parseInt(getAttr(node, 'data-h') || '0'),
          alt: getAttr(node, 'alt'),
          index: imageIndex++,
          dataType: getAttr(node, 'data-type'),
          context: extractImageContext(node),
        });
        return;
      }

      // 轮播图容器
      if (isGalleryContainer(node)) {
        const gallerySrcs = [];
        $(node).find('img').each((_, img) => {
          const gSrc = getAttr(img, 'data-src').startsWith('http') ? getAttr(img, 'data-src')
                     : getAttr(img, 'src').startsWith('http') ? getAttr(img, 'src') : '';
          if (gSrc && !gSrc.startsWith('data:') && !isLikelyDecorative(img)) {
            gallerySrcs.push({
              src: gSrc,
              width: parseInt(getAttr(img, 'data-w') || '0'),
              height: parseInt(getAttr(img, 'data-h') || '0'),
            });
          }
        });
        if (gallerySrcs.length > 0) elements.push({ type: 'gallery', images: gallerySrcs, index: imageIndex++ });
        return;
      }

      // 背景图
      const bgMatch = getStyle(node).match(/background-image\s*:\s*url\(["']?(https?:\/\/[^"')]+)["']?\)/);
      if (bgMatch) elements.push({ type: 'background_image', src: bgMatch[1], index: imageIndex++ });

      // 标题
      if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
        const text = getNodeText(node);
        if (text) { elements.push({ type: 'heading', level: parseInt(tag[1]), content: text }); return; }
      }

      if (tag === 'br') { elements.push({ type: 'break' }); return; }

      if (tag === 'li') {
        const text = getNodeText(node);
        if (text) { elements.push({ type: 'list_item', content: text }); return; }
      }

      if (tag === 'strong' || tag === 'b') {
        const text = getNodeText(node);
        if (text) {
          const last = elements[elements.length - 1];
          if (last && last.type === 'text' && last.content.endsWith(text)) { last.bold = true; }
          else { elements.push({ type: 'text', content: text, bold: true }); }
          return;
        }
      }

      const isBlock = ['p','div','section','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','li','br'].includes(tag);
      for (const child of (node.children || [])) walkDOM(child, depth + 1);
      if (isBlock && tag !== 'br') {
        const last = elements[elements.length - 1];
        if (last && last.type !== 'paragraph_break') elements.push({ type: 'paragraph_break' });
      }
      return;
    }

    // 文本节点
    if (node.type === 'text') {
      const text = (node.data || '').trim();
      if (text) {
        const last = elements[elements.length - 1];
        if (last && last.type === 'text') last.content += text;
        else elements.push({ type: 'text', content: text });
      }
      return;
    }

    for (const child of (node.children || [])) walkDOM(child, depth + 1);
  }

  walkDOM(contentEl);

  // 清理：合并相邻 paragraph_break，去除首尾空白
  const cleaned = [];
  for (const el of elements) {
    if (el.type === 'paragraph_break' || el.type === 'break') {
      const last = cleaned[cleaned.length - 1];
      if (last && (last.type === 'paragraph_break' || last.type === 'break')) continue;
      cleaned.push(el);
    } else if (el.type === 'text' && el.content.trim() === '') {
      continue;
    } else {
      cleaned.push(el);
    }
  }
  while (cleaned.length > 0 && (cleaned[0].type === 'paragraph_break' || cleaned[0].type === 'break')) cleaned.shift();
  while (cleaned.length > 0 && (cleaned[cleaned.length - 1].type === 'paragraph_break' || cleaned[cleaned.length - 1].type === 'break')) cleaned.pop();

  return { title, author, publishTime, elements: cleaned };
}

// ─── 本地路径：Puppeteer + 系统 Chrome ──────────────────────────────────────

async function scrapeWithPuppeteer(url) {
  const { default: puppeteer } = await import('puppeteer-core');

  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.CHROME_PATH,
  ].filter(Boolean);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chromePaths[0],
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--window-size=1280,800'],
    protocolTimeout: 180000,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50');

    console.log('📖 正在打开文章...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('#js_content', { timeout: 10000 });

    console.log('🖼️  正在处理懒加载图片...');
    await forceLoadAllImages(page);
    console.log('📜 正在滚动页面触发加载...');
    await autoScroll(page);
    await forceLoadAllImages(page);
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('#js_content img[src]:not([src=""])');
      return imgs.length > 0;
    }, { timeout: 5000 }).catch(() => {});
    await waitForImagesLoaded(page);

    console.log('📝 正在提取文章结构...');
    return await extractArticleStructure(page);
  } finally {
    await browser.close();
  }
}

async function forceLoadAllImages(page) {
  await page.evaluate(() => {
    document.querySelectorAll('img[data-src]').forEach(img => {
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc && !img.src.startsWith('http')) img.src = dataSrc;
    });
    document.querySelectorAll('.swiper_page img[data-src], .js_album_container img[data-src], .wx_pic_swiper img[data-src]').forEach(img => {
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc && !img.src.startsWith('http')) img.src = dataSrc;
    });
    document.querySelectorAll('.swiper_page, .wx_pic_swiper_item').forEach(el => {
      el.style.display = 'block';
      el.style.visibility = 'visible';
      el.style.opacity = '1';
    });
  });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
    });
  });
}

async function waitForImagesLoaded(page) {
  await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('#js_content img[src^="http"]'));
    await Promise.allSettled(
      imgs.map(img =>
        img.complete ? Promise.resolve() :
        new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
          setTimeout(resolve, 5000);
        })
      )
    );
  });
}

async function extractArticleStructure(page) {
  return await page.evaluate(() => {
    const title = document.getElementById('activity-name')?.textContent?.trim() || '';
    const author = document.getElementById('js_name')?.textContent?.trim() || '';
    const publishTime = document.getElementById('publish_time')?.textContent?.trim() || '';
    const content = document.getElementById('js_content');
    if (!content) return { title, author, publishTime, elements: [] };

    const elements = [];
    let imageIndex = 0;

    function isLikelyDecorative(img) {
      const w = parseInt(img.getAttribute('data-w') || img.naturalWidth || img.width || 0);
      const h = parseInt(img.getAttribute('data-h') || img.naturalHeight || img.height || 0);
      const src = img.src || img.getAttribute('data-src') || '';
      if (w > 0 && w < 30) return true;
      if (h > 0 && h < 30) return true;
      if (src.includes("1px' height='1px")) return true;
      if (src.startsWith('data:image/svg+xml') && w === 0 && h === 0) return true;
      if (!src || src === '') return true;
      if (src.includes('mmbiz_svg')) return true;
      return false;
    }

    function isGalleryContainer(el) {
      const cls = (typeof el.className === 'string' ? el.className : el.className?.baseVal || '') || '';
      return cls.includes('swiper') || cls.includes('album') ||
             cls.includes('wx_pic_swiper') || cls.includes('js_img_swiper');
    }

    function extractImageContext(imgNode) {
      const context = { before: '', after: '', caption: '' };
      if (imgNode.alt && imgNode.alt.trim()) context.caption = imgNode.alt.trim().substring(0, 100);

      let ancestor = imgNode.parentElement;
      let depth = 0;
      while (ancestor && ancestor !== content && depth < 8) {
        const cls = (typeof ancestor.className === 'string' ? ancestor.className : ancestor.className?.baseVal || '') || '';
        if (cls.includes('img_desc') || cls.includes('img-desc') || cls.includes('caption')) {
          const text = ancestor.textContent.trim();
          if (text && text.length > 0 && text.length < 150) { context.caption = text; break; }
        }
        const nextSib = ancestor.nextElementSibling;
        if (nextSib && !nextSib.querySelector('img')) {
          const text = nextSib.textContent.trim();
          if (text && text.length > 0 && text.length <= 80 && nextSib.querySelectorAll('section').length < 3) {
            context.caption = text; break;
          }
        }
        ancestor = ancestor.parentElement;
        depth++;
      }

      let topAncestor = imgNode.parentElement;
      while (topAncestor && topAncestor.parentElement && topAncestor.parentElement !== content) {
        topAncestor = topAncestor.parentElement;
      }
      if (topAncestor) {
        const prevSib = topAncestor.previousElementSibling;
        const nextSibCtx = topAncestor.nextElementSibling;
        if (prevSib && !prevSib.querySelector('img')) context.before = prevSib.textContent.trim().substring(0, 150);
        if (nextSibCtx && !nextSibCtx.querySelector('img')) context.after = nextSibCtx.textContent.trim().substring(0, 150);
      }
      return context;
    }

    function walkDOM(node, depth = 0) {
      if (!node) return;
      if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        const cls = (typeof node.className === 'string' ? node.className : node.className?.baseVal || '') || '';
        const id = node.id || '';
        const style = window.getComputedStyle(node);
        if (style.display === 'none' && !isGalleryContainer(node)) return;
        if (id === 'js_profile_qrcode' || id === 'js_tags' ||
            cls.includes('reward') || cls.includes('qr_code') ||
            cls.includes('rich_media_tool') || cls.includes('function_mod')) return;

        if (tag === 'img') {
          const dataSrc = node.getAttribute('data-src') || '';
          const dataOriginalSrc = node.getAttribute('data-original-src') || '';
          const dataWSrc = node.getAttribute('data-w-src') || '';
          const rawSrc = node.src || '';
          let src = '';
          if (dataSrc.startsWith('http')) src = dataSrc;
          else if (dataOriginalSrc.startsWith('http')) src = dataOriginalSrc;
          else if (dataWSrc.startsWith('http')) src = dataWSrc;
          else if (rawSrc.startsWith('http')) src = rawSrc;
          if (src) src = src.split('#')[0];
          if (!src || isLikelyDecorative(node)) return;
          if (src.startsWith('data:image/svg+xml')) return;
          elements.push({
            type: 'image', src,
            width: parseInt(node.getAttribute('data-w') || node.naturalWidth || 0),
            height: parseInt(node.getAttribute('data-h') || node.naturalHeight || 0),
            alt: node.alt || '', index: imageIndex++,
            dataType: node.getAttribute('data-type') || '',
            context: extractImageContext(node),
          });
          return;
        }

        if (isGalleryContainer(node)) {
          const gallerySrcs = [];
          node.querySelectorAll('img').forEach(img => {
            const gDataSrc = img.getAttribute('data-src') || '';
            const gRawSrc = img.src || '';
            const src = (gDataSrc.startsWith('http') ? gDataSrc : null) || (gRawSrc.startsWith('http') ? gRawSrc : '') || '';
            if (src && !src.startsWith('data:') && !isLikelyDecorative(img)) {
              gallerySrcs.push({ src, width: parseInt(img.getAttribute('data-w') || img.naturalWidth || 0), height: parseInt(img.getAttribute('data-h') || img.naturalHeight || 0) });
            }
          });
          if (gallerySrcs.length > 0) elements.push({ type: 'gallery', images: gallerySrcs, index: imageIndex++ });
          return;
        }

        if (node.style.backgroundImage && node.style.backgroundImage.includes('url(')) {
          const match = node.style.backgroundImage.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          if (match) elements.push({ type: 'background_image', src: match[1], index: imageIndex++ });
        }
      }

      if (node.nodeType === 3) {
        const text = node.textContent.trim();
        if (text) {
          const last = elements[elements.length - 1];
          if (last && last.type === 'text') last.content += text;
          else elements.push({ type: 'text', content: text });
        }
        return;
      }

      if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        const isBlock = ['p','div','section','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','li','br'].includes(tag);
        if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
          const text = node.textContent.trim();
          if (text) { elements.push({ type: 'heading', level: parseInt(tag[1]), content: text }); return; }
        }
        if (tag === 'br') { elements.push({ type: 'break' }); return; }
        if (tag === 'li') {
          const text = node.textContent.trim();
          if (text) { elements.push({ type: 'list_item', content: text }); return; }
        }
        if (tag === 'strong' || tag === 'b') {
          const text = node.textContent.trim();
          if (text) {
            const last = elements[elements.length - 1];
            if (last && last.type === 'text' && last.content.endsWith(text)) last.bold = true;
            else elements.push({ type: 'text', content: text, bold: true });
            return;
          }
        }
        for (const child of node.childNodes) walkDOM(child, depth + 1);
        if (isBlock && tag !== 'br') {
          const last = elements[elements.length - 1];
          if (last && last.type !== 'paragraph_break') elements.push({ type: 'paragraph_break' });
        }
        return;
      }

      for (const child of (node.childNodes || [])) walkDOM(child, depth + 1);
    }

    walkDOM(content);

    const cleaned = [];
    for (const el of elements) {
      if (el.type === 'paragraph_break' || el.type === 'break') {
        const last = cleaned[cleaned.length - 1];
        if (last && (last.type === 'paragraph_break' || last.type === 'break')) continue;
        cleaned.push(el);
      } else if (el.type === 'text' && el.content.trim() === '') {
        continue;
      } else {
        cleaned.push(el);
      }
    }
    while (cleaned.length > 0 && (cleaned[0].type === 'paragraph_break' || cleaned[0].type === 'break')) cleaned.shift();
    while (cleaned.length > 0 && (cleaned[cleaned.length - 1].type === 'paragraph_break' || cleaned[cleaned.length - 1].type === 'break')) cleaned.pop();

    return { title, author, publishTime, elements: cleaned };
  });
}
