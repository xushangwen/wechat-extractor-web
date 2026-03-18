// Vercel Serverless Function - 仅用于前端展示
export default function handler(req, res) {
  res.status(503).json({
    error: '后端服务不可用',
    message: '此项目依赖 Puppeteer 和 Chrome 浏览器，无法在 Vercel Serverless 环境中运行。',
    solutions: [
      '1. 本地运行：npm install && npm start',
      '2. 部署到 Railway：railway up',
      '3. 部署到 Render：https://render.com',
      '4. 使用 Docker 部署到云服务器'
    ],
    documentation: 'https://github.com/xushangwen/wechat-extractor-web/blob/main/README-DEPLOYMENT.md'
  });
}
