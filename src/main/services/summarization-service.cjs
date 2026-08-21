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
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^<\/think>\s*/i, '')
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
          content: '你是专业的中文课程笔记助手，一律使用简体中文。阅读逐字稿片段后，用自己通顺的书面语归纳要点：合并重复内容，删除口头语和过渡句，把零散表述整理成清晰的条目。所有信息必须来自原文，禁止添加原文没有的事实、数字、人名或结论。/no_think'
        },
        {
          role: 'user',
          content: `下面是逐字稿的第 ${index + 1}/${chunks.length} 部分。请归纳这一部分的关键内容，保留观点、方法、步骤、案例、数字和限定条件。用自己的话写成通顺的要点，不要照抄原句，不要写开场白，不规定条数。\n\n${chunks[index]}`
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
          { role: 'system', content: '合并同类项并删除重复表述，一律使用简体中文。保留全部具体信息，可以调整语序让表达更通顺，禁止添加输入材料中没有的事实。/no_think' },
          { role: 'user', content: group }
        ], signal, 700));
      }
      synthesisMaterial = reduced.join('\n\n');
    }

    onProgress({ phase: 'final', percent: 84 });
    const summary = await chat(baseUrl, [
      {
        role: 'system',
        content: '你是专业的中文课程编辑，一律使用简体中文。根据输入材料撰写读者友好的总结：用完整通顺的句子归纳和概括，可以重组信息、合并同类项，而不是罗列原文片段。所有事实必须来自材料，禁止编造数据、人名、案例或材料中没有的延伸结论。/no_think'
      },
      {
        role: 'user',
        content: `请把下面材料整理为最终总结，严格使用二级标题：\n\n## 内容概览\n用两三句话概括材料讲了什么。\n\n## 核心观点\n分条列出材料表达的主要观点，每条用一句通顺的话概括。\n\n## 重要细节\n整理材料中实际出现的方法、步骤、案例、数据和限定条件。\n\n## 值得进一步看的部分\n列出值得回到完整文字稿细读的主题；没有就写“未涉及”。\n\n直接陈述内容，不要出现“根据材料”“本视频”等字眼，不要编造材料没有的信息。\n\n${synthesisMaterial}`
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
