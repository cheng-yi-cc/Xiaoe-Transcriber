const net = require('node:net');
const path = require('node:path');
const { spawnManaged } = require('./process-runner.cjs');
const { chunkTranscript } = require('./transcript-utils.cjs');
const { buildExtractiveSummary, evaluateGeneratedSummary } = require('./extractive-summary.cjs');

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
          content: '你是专业的中文内容编辑，一律使用简体中文。阅读逐字稿片段后，用连贯的书面语概述这一部分讲了什么：合并重复表述，省略口头语、寒暄和过渡句。所有信息必须来自原文，禁止添加原文没有的事实、数字、人名或结论。/no_think'
        },
        {
          role: 'user',
          content: `下面是逐字稿的第 ${index + 1}/${chunks.length} 部分。请用一到两个自然段连贯地概括这部分讲了什么，覆盖主要话题和关键结论，保留重要的观点、方法、步骤、数字和限定条件。用自己的话叙述，不要分点罗列，不要照抄原句，不要写开场白。\n\n${chunks[index]}`
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
        content: '你是专业的中文编辑，一律使用简体中文。根据输入材料撰写一篇概括性的内容总结：用完整通顺的段落讲清楚这次直播整体讲了什么、围绕哪些主题展开、得出了什么结论或建议。用概括和重组的方式写作，而不是罗列或摘抄原文片段。所有事实必须来自材料，禁止编造数据、人名、案例或材料中没有的延伸结论。/no_think'
      },
      {
        role: 'user',
        content: `请把下面材料概括为一篇总结，直接输出正文：\n- 写成三到五个自然段的连贯短文；不要使用任何标题、列表、编号或加粗，不要分点罗列。\n- 第一段总起：这次直播的主题和面向的听众。\n- 中间各段按材料脉络概括主要讲了什么。\n- 最后一段收束核心结论或建议（材料里没有就不写）。\n- 不要出现“根据材料”“文中提到”这类字眼，不要罗列关键词或词频，不要编造材料没有的信息。\n\n${synthesisMaterial}`
      }
    ], signal, 1400);
    onProgress({ phase: 'complete', percent: 100 });
    const evaluation = evaluateGeneratedSummary(summary, transcript);
    return {
      text: evaluation.supported ? summary : buildExtractiveSummary(transcript),
      modelOutput: summary,
      gatePassed: evaluation.supported,
      gateReason: evaluation.reason
    };
  } catch (error) {
    if (!signal?.aborted && serverTail) error.message = `${error.message}\n${serverTail.slice(-2500)}`;
    throw error;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

module.exports = { chat, reservePort, summarizeTranscript, waitForServer };
