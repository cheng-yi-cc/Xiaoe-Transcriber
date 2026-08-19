const net = require('node:net');
const path = require('node:path');
const { spawnManaged } = require('./process-runner.cjs');
const { chunkTranscript } = require('./transcript-utils.cjs');
const { buildExtractiveSummary, generatedSummaryIsSupported } = require('./extractive-summary.cjs');

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child, signal, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (child.exitCode !== null) throw new Error(`本地总结引擎启动失败（退出码 ${child.exitCode}）。`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal });
      if (response.ok) return;
    } catch {
      // The server is still loading the model.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('本地总结模型启动超时。');
}

async function chat(baseUrl, messages, signal, maxTokens = 700) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'local-summary',
      messages,
      temperature: 0,
      top_p: 0.8,
      max_tokens: maxTokens,
      stream: false
    }),
    signal
  });
  if (!response.ok) throw new Error(`本地总结请求失败（HTTP ${response.status}）。`);
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('本地总结模型返回了空内容。');
    return content
      .replace(/^```(?:markdown)?\s*/i, '')
      .replace(/\s*```$/, '')
      .replace(/^#{3,}\s+/gm, '## ')
      .trim();
}

async function summarizeTranscript({ llamaServerPath, modelPath, transcript, signal, onProgress = () => {} }) {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverTail = '';
  const child = spawnManaged(llamaServerPath, [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-ngl', '99',
    '-c', '8192',
    '--parallel', '1'
  ], { cwd: path.dirname(llamaServerPath), signal });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { serverTail = `${serverTail}${chunk}`.slice(-10000); });
  }

  try {
    onProgress({ phase: 'loading', percent: 2 });
    await waitForServer(baseUrl, child, signal);
    const chunks = chunkTranscript(transcript);
    const partials = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const content = await chat(baseUrl, [
        {
          role: 'system',
          content: '你是严谨的中文课程笔记助手。只能摘取或压缩逐字稿明确说出的内容。每条要点必须能在原文中找到直接依据；禁止推测目的、好处、风险、影响或背景。材料很少时宁可只写一两条，不要凑数。'
        },
        {
          role: 'user',
          content: `下面是逐字稿的第 ${index + 1}/${chunks.length} 部分。请使用原稿中的词语提取少量关键信息，保留观点、方法、案例和限定条件。逐条自检：如果找不到原文依据就删除。不要写开场白，不规定条数。\n\n${chunks[index]}`
        }
      ], signal, 650);
      partials.push(`### 第 ${index + 1} 部分\n${content}`);
      onProgress({ phase: 'chunks', completed: index + 1, total: chunks.length, percent: 5 + Math.round(((index + 1) / chunks.length) * 72) });
    }

    let synthesisMaterial = chunks.length === 1 ? transcript : partials.join('\n\n');
    while (synthesisMaterial.length > 11500) {
      const groups = chunkTranscript(synthesisMaterial, 5200);
      const reduced = [];
      for (const group of groups) {
        reduced.push(await chat(baseUrl, [
          { role: 'system', content: '合并同类项并删除重复表述。每条都必须有输入材料直接支持；禁止补充常识、推测、效果或背景。' },
          { role: 'user', content: group }
        ], signal, 700));
      }
      synthesisMaterial = reduced.join('\n\n');
    }

    onProgress({ phase: 'final', percent: 84 });
    const summary = await chat(baseUrl, [
      {
        role: 'system',
        content: '你是严谨的中文课程内容编辑。只能压缩输入材料明确包含的信息，禁止补充常识、推测、效果、目的或背景。写完后逐条检查，删除找不到直接依据的句子。宁可简短或写“未涉及”，也不要为了完整而凑内容。使用简体中文 Markdown。'
      },
      {
        role: 'user',
        content: `请把下面材料整理为最终总结，严格使用二级标题：\n\n## 内容概览\n简短说明材料明确讲了什么。\n\n## 核心观点\n列出材料明确表达的观点；没有就写“未涉及明确观点”。\n\n## 重要细节\n只保留材料中实际出现的方法、案例、论据或限定条件；没有就写“未涉及”。\n\n## 值得进一步看的部分\n只列出材料中已经出现、且值得回到完整文字稿阅读的主题；没有就写“未涉及”。\n\n不要写“根据材料”“本视频”等空话。不要扩展原文没有说出的好处、影响、风险、用途或结论。\n\n${synthesisMaterial}`
      }
    ], signal, 1400);
    onProgress({ phase: 'complete', percent: 100 });
    return generatedSummaryIsSupported(summary, transcript)
      ? summary
      : buildExtractiveSummary(transcript);
  } catch (error) {
    if (!signal?.aborted && serverTail) error.message = `${error.message}\n${serverTail.slice(-2500)}`;
    throw error;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

module.exports = { chat, reservePort, summarizeTranscript, waitForServer };
