import puppeteer from 'puppeteer-core';

/**
 * 微信公众号文章抓取器
 * 处理懒加载、轮播图、背景图等场景
 */
export async function scrapeArticle(url) {
  // 查找系统 Chrome
  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.CHROME_PATH,
  ].filter(Boolean);

  const executablePath = chromePaths[0];

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--window-size=1280,800',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // 模拟移动端 UA（微信文章在移动端展示更完整）
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50'
  );

  console.log('📖 正在打开文章...');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('#js_content', { timeout: 10000 });

  // 强制触发所有懒加载：替换 data-src → src
  console.log('🖼️  正在处理懒加载图片...');
  await forceLoadAllImages(page);

  // 逐步滚动页面触发 IntersectionObserver
  console.log('📜 正在滚动页面触发加载...');
  await autoScroll(page);

  // 再次强制加载（滚动可能触发了新的懒加载元素）
  await forceLoadAllImages(page);
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('#js_content img[src]:not([src=""])');
    return imgs.length > 0;
  }, { timeout: 5000 }).catch(() => {});

  // 等待图片加载完成
  await waitForImagesLoaded(page);

  // 提取文章结构化内容
  console.log('📝 正在提取文章结构...');
  const articleData = await extractArticleStructure(page);

  await browser.close();
  return articleData;
}

/**
 * 强制将所有 data-src 替换为 src，触发图片加载
 */
async function forceLoadAllImages(page) {
  await page.evaluate(() => {
    // 处理所有 img 标签的 data-src（保留 data-src 作为备用）
    document.querySelectorAll('img[data-src]').forEach(img => {
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc && !img.src.startsWith('http')) {
        img.src = dataSrc;
      }
    });

    // 处理轮播图容器中可能隐藏的图片
    document.querySelectorAll('.swiper_page img[data-src], .js_album_container img[data-src], .wx_pic_swiper img[data-src]').forEach(img => {
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc && !img.src.startsWith('http')) {
        img.src = dataSrc;
      }
    });

    // 展开所有被折叠的轮播图页
    document.querySelectorAll('.swiper_page, .wx_pic_swiper_item').forEach(el => {
      el.style.display = 'block';
      el.style.visibility = 'visible';
      el.style.opacity = '1';
    });
  });
}

/**
 * 自动滚动页面到底部，触发所有懒加载
 */
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
          // 滚回顶部
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
    });
  });
}

/**
 * 等待页面上所有图片加载完成
 */
async function waitForImagesLoaded(page) {
  await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('#js_content img[src^="http"]'));
    await Promise.allSettled(
      imgs.map(img =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
              setTimeout(resolve, 5000);
            })
      )
    );
  });
}

/**
 * 提取文章结构化内容（文字+图片，保留排版顺序）
 */
async function extractArticleStructure(page) {
  return await page.evaluate(() => {
    const title = document.getElementById('activity-name')?.textContent?.trim() || '';
    const author = document.getElementById('js_name')?.textContent?.trim() || '';
    const publishTime = document.getElementById('publish_time')?.textContent?.trim() || '';
    const content = document.getElementById('js_content');
    if (!content) return { title, author, publishTime, elements: [] };

    const elements = [];
    let imageIndex = 0;

    /**
     * 判断元素是否可能是装饰性元素
     */
    function isLikelyDecorative(img) {
      const w = parseInt(img.getAttribute('data-w') || img.naturalWidth || img.width || 0);
      const h = parseInt(img.getAttribute('data-h') || img.naturalHeight || img.height || 0);
      const src = img.src || img.getAttribute('data-src') || '';
      const alt = img.alt || '';

      // 很小的图片（宽或高 < 30px）基本是装饰图
      if (w > 0 && w < 30) return true;
      if (h > 0 && h < 30) return true;

      // 1x1 占位图
      if (src.includes("1px' height='1px")) return true;

      // data URI 占位图
      if (src.startsWith('data:image/svg+xml') && w === 0 && h === 0) return true;

      // 空 src
      if (!src || src === '') return true;

      // 微信 SVG 装饰图（URL 包含 mmbiz_svg）
      if (src.includes('mmbiz_svg')) return true;

      return false;
    }

    /**
     * 判断是否为轮播/相册容器
     */
    function isGalleryContainer(el) {
      const cls = (typeof el.className === 'string' ? el.className : el.className?.baseVal || '') || '';
      return cls.includes('swiper') || cls.includes('album') ||
             cls.includes('wx_pic_swiper') || cls.includes('js_img_swiper');
    }

    /**
     * 递归遍历 DOM，提取内容元素
     */
    function walkDOM(node, depth = 0) {
      if (!node) return;

      // 跳过不需要的元素
      if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        const cls = (typeof node.className === 'string' ? node.className : node.className?.baseVal || '') || '';
        const id = node.id || '';

        // 跳过隐藏元素
        const style = window.getComputedStyle(node);
        if (style.display === 'none' && !isGalleryContainer(node)) return;

        // 跳过非内容区域
        if (id === 'js_profile_qrcode' || id === 'js_tags' ||
            cls.includes('reward') || cls.includes('qr_code') ||
            cls.includes('rich_media_tool') || cls.includes('function_mod')) return;

        // 处理图片（优先使用 data-src，它是微信懒加载的真实 URL）
        if (tag === 'img') {
          const dataSrc = node.getAttribute('data-src') || '';
          const rawSrc = node.src || '';
          const src = (dataSrc.startsWith('http') ? dataSrc : null) || (rawSrc.startsWith('http') ? rawSrc : '') || '';
          if (!src || isLikelyDecorative(node)) return;
          // 过滤占位SVG
          if (src.startsWith('data:image/svg+xml')) return;

          const w = parseInt(node.getAttribute('data-w') || node.naturalWidth || 0);
          const h = parseInt(node.getAttribute('data-h') || node.naturalHeight || 0);

          elements.push({
            type: 'image',
            src: src,
            width: w,
            height: h,
            alt: node.alt || '',
            index: imageIndex++,
            dataType: node.getAttribute('data-type') || '',
          });
          return;
        }

        // 处理轮播图容器 - 提取内部所有图片
        if (isGalleryContainer(node)) {
          const galleryImages = node.querySelectorAll('img');
          const gallerySrcs = [];
          galleryImages.forEach(img => {
            const gDataSrc = img.getAttribute('data-src') || '';
            const gRawSrc = img.src || '';
            const src = (gDataSrc.startsWith('http') ? gDataSrc : null) || (gRawSrc.startsWith('http') ? gRawSrc : '') || '';
            if (src && !src.startsWith('data:') && !isLikelyDecorative(img)) {
              gallerySrcs.push({
                src,
                width: parseInt(img.getAttribute('data-w') || img.naturalWidth || 0),
                height: parseInt(img.getAttribute('data-h') || img.naturalHeight || 0),
              });
            }
          });
          if (gallerySrcs.length > 0) {
            elements.push({
              type: 'gallery',
              images: gallerySrcs,
              index: imageIndex++,
            });
          }
          return; // 不再递归进入
        }

        // 处理背景图（仅记录 URL，后续由 Gemini 判断是否装饰）
        if (node.style.backgroundImage && node.style.backgroundImage.includes('url(')) {
          const match = node.style.backgroundImage.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          if (match) {
            elements.push({
              type: 'background_image',
              src: match[1],
              index: imageIndex++,
            });
          }
        }
      }

      // 文本节点
      if (node.nodeType === 3) {
        const text = node.textContent.trim();
        if (text) {
          // 合并连续文本
          const last = elements[elements.length - 1];
          if (last && last.type === 'text') {
            last.content += text;
          } else {
            elements.push({ type: 'text', content: text });
          }
        }
        return;
      }

      // 处理块级元素的换行
      if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        const isBlock = ['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'br'].includes(tag);

        // 处理标题
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          const text = node.textContent.trim();
          if (text) {
            elements.push({
              type: 'heading',
              level: parseInt(tag[1]),
              content: text,
            });
            return;
          }
        }

        // 处理换行
        if (tag === 'br') {
          elements.push({ type: 'break' });
          return;
        }

        // 处理列表项
        if (tag === 'li') {
          const text = node.textContent.trim();
          if (text) {
            elements.push({ type: 'list_item', content: text });
            return;
          }
        }

        // 处理加粗文本的特殊检测
        if (tag === 'strong' || tag === 'b') {
          const text = node.textContent.trim();
          if (text) {
            // 检查父级是否已经处理了文本
            const last = elements[elements.length - 1];
            if (last && last.type === 'text' && last.content.endsWith(text)) {
              // 标记为粗体
              last.bold = true;
            } else {
              elements.push({ type: 'text', content: text, bold: true });
            }
            return;
          }
        }

        // 递归子节点
        for (const child of node.childNodes) {
          walkDOM(child, depth + 1);
        }

        // 块级元素后添加段落分隔
        if (isBlock && tag !== 'br') {
          const last = elements[elements.length - 1];
          if (last && last.type !== 'paragraph_break') {
            elements.push({ type: 'paragraph_break' });
          }
        }
        return;
      }

      // 其他节点类型，递归子节点
      for (const child of (node.childNodes || [])) {
        walkDOM(child, depth + 1);
      }
    }

    walkDOM(content);

    // 清理：合并相邻的 paragraph_break，去除首尾空白
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

    // 去除首尾 paragraph_break
    while (cleaned.length > 0 && (cleaned[0].type === 'paragraph_break' || cleaned[0].type === 'break')) {
      cleaned.shift();
    }
    while (cleaned.length > 0 && (cleaned[cleaned.length - 1].type === 'paragraph_break' || cleaned[cleaned.length - 1].type === 'break')) {
      cleaned.pop();
    }

    return { title, author, publishTime, elements: cleaned };
  });
}
