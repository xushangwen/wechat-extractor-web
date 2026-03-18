import 'dotenv/config';
import express from 'express';
import { spawn } from 'child_process';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const tasks = new Map();

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, '');
}

app.get('/api/extract', (req, res) => {
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
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('start', { taskId });

  const child = spawn('node', ['index.js', url], {
    cwd: __dirname,
    env: { ...process.env },
  });

  let outputDir = null;
  let articleTitle = null;
  let stdoutBuffer = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('__OUTPUT__:')) {
        try {
          const data = JSON.parse(trimmed.slice(11));
          outputDir = data.dir;
          articleTitle = data.title;
          tasks.set(taskId, { outputDir, title: articleTitle });
        } catch {}
      } else {
        send('log', { message: stripAnsi(trimmed) });
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const msg = stripAnsi(chunk.toString().trim());
    if (msg) send('log', { message: msg, isError: true });
  });

  child.on('close', (code) => {
    if (stdoutBuffer.trim()) {
      const trimmed = stdoutBuffer.trim();
      if (!trimmed.startsWith('__OUTPUT__:')) {
        send('log', { message: stripAnsi(trimmed) });
      }
    }

    if (code === 0 && outputDir) {
      send('complete', {
        taskId,
        title: articleTitle,
        downloadUrl: `/api/download/${taskId}`,
      });
    } else {
      send('error', { message: `提取失败，进程退出码 ${code}` });
    }
    res.end();
  });

  req.on('close', () => {
    if (child.exitCode === null) child.kill();
  });
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

  archive.on('error', (err) => {
    console.error('打包错误:', err);
  });

  archive.pipe(res);
  archive.directory(outputDir, dirName);
  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`\n🚀 微信文章提取器已启动`);
  console.log(`   访问: http://localhost:${PORT}\n`);
});
