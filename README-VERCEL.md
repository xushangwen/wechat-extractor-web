# Vercel 部署指南

## ✅ 完整功能支持

此项目现已支持在 Vercel 上完整运行，包括文章提取功能！

## 🚀 部署步骤

### 1. 环境变量配置

在 Vercel 项目设置中添加以下环境变量：

```
GEMINI_API_KEY=your_gemini_api_key_here
```

### 2. 部署方式

**方式 A：通过 Vercel CLI**
```bash
vercel --prod
```

**方式 B：通过 GitHub 集成**
1. 将代码推送到 GitHub
2. 在 Vercel 导入 GitHub 仓库
3. 添加环境变量
4. 自动部署

## 📋 技术实现

- **浏览器支持**：使用 `@sparticuz/chromium` 在 Vercel serverless 环境运行 Chromium
- **内存配置**：3008 MB（支持浏览器运行）
- **超时时间**：300 秒（支持长时间提取）
- **环境检测**：自动识别 Vercel 环境并使用对应配置

## ⚙️ 配置说明

### vercel.json
```json
{
  "functions": {
    "server.js": {
      "maxDuration": 300,  // 5 分钟超时
      "memory": 3008       // 3GB 内存
    }
  }
}
```

### 本地开发
```bash
npm install
npm start
# 访问 http://localhost:3000
```

## 🔧 故障排除

### 问题：Connection error
**原因**：环境变量未配置或 Chromium 初始化失败
**解决**：
1. 确认 `GEMINI_API_KEY` 已在 Vercel 设置
2. 检查 Vercel 函数日志
3. 确保使用 Pro 计划（免费版有 10 秒限制）

### 问题：超时错误
**原因**：文章过长或网络慢
**解决**：
1. 升级到 Vercel Pro（300 秒超时）
2. 或使用本地运行

## 💡 注意事项

1. **Vercel 免费版限制**：
   - 函数超时：10 秒
   - 内存：1024 MB
   - **不支持长时间运行的任务**

2. **推荐使用 Vercel Pro**：
   - 函数超时：300 秒
   - 内存：3008 MB
   - 完全支持文章提取

3. **替代方案**（如不想付费）：
   - Railway（免费，支持长时间运行）
   - Render（免费，支持长时间运行）
   - 本地运行

## 📊 性能优化

- Chromium 自动下载和缓存
- 图片并发下载
- AI 分析批量处理
- 内存自动管理

## 🌐 在线访问

部署成功后，访问你的 Vercel 域名即可使用完整功能。
