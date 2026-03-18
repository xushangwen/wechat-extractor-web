# 部署说明

## ⚠️ Vercel 部署限制

**重要提示**：此项目**无法直接部署到 Vercel**，原因如下：

1. **Puppeteer 依赖**：项目使用 Puppeteer 抓取网页，需要完整的 Chrome 浏览器环境
2. **Serverless 限制**：Vercel 的 serverless 函数不支持运行浏览器
3. **执行时间**：文章提取需要 30-120 秒，超过 Vercel 免费版的 10 秒限制

## ✅ 推荐部署方案

### 方案 1：Railway / Render（推荐）
这些平台支持长时间运行的 Node.js 应用：

**Railway 部署**：
```bash
# 1. 安装 Railway CLI
npm install -g @railway/cli

# 2. 登录
railway login

# 3. 初始化项目
railway init

# 4. 部署
railway up
```

**Render 部署**：
1. 访问 https://render.com
2. 连接 GitHub 仓库
3. 选择 "Web Service"
4. 构建命令：`npm install`
5. 启动命令：`npm start`

### 方案 2：Docker + 云服务器
部署到支持 Docker 的云平台（阿里云、腾讯云、AWS 等）

### 方案 3：本地运行
```bash
npm install
npm start
# 访问 http://localhost:3000
```

## 📝 环境变量配置

无论哪种部署方式，都需要配置：

```env
GEMINI_API_KEY=your_api_key_here
PORT=3000
```

## 🔧 Vercel 仅用于前端展示

当前 Vercel 部署只能展示前端界面，**无法执行文章提取功能**。

如需完整功能，请使用上述推荐的部署方案。
