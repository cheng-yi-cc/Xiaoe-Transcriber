const fsp = require('node:fs/promises');
const path = require('node:path');

function metadataBlock({ sourceUrl, generatedAt = new Date() }) {
  const date = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(generatedAt);
  return `> 来源：${sourceUrl}\n>\n> 生成时间：${date}（本地离线处理）`;
}

async function writeTranscriptFile({ resultDirectory, title, sourceUrl, transcript }) {
  const filePath = path.join(resultDirectory, '完整文字稿.md');
  const body = `# ${title}｜完整文字稿\n\n${metadataBlock({ sourceUrl })}\n\n${transcript.trim()}\n`;
  await fsp.writeFile(filePath, body, 'utf8');
  return filePath;
}

async function writeSummaryFile({ resultDirectory, title, sourceUrl, summary }) {
  const filePath = path.join(resultDirectory, '总结.md');
  const body = `# ${title}｜总结\n\n${metadataBlock({ sourceUrl })}\n\n${summary.trim()}\n`;
  await fsp.writeFile(filePath, body, 'utf8');
  return filePath;
}

async function writeRawModelOutput({ resultDirectory, sourceUrl, output, reason }) {
  const filePath = path.join(resultDirectory, '总结-模型原始输出（未通过校验）.md');
  const body = `# 模型原始输出（未通过可靠性校验，仅供参考）\n\n> 拒绝原因：${reason || '未通过可靠性校验。'}\n>\n> 下面是本地总结模型的原始输出，未经修改。正式交付的 总结.md 已改用逐字稿原文摘录。\n\n${String(output || '').trim()}\n`;
  await fsp.writeFile(filePath, body, 'utf8');
  return filePath;
}

module.exports = { metadataBlock, writeRawModelOutput, writeSummaryFile, writeTranscriptFile };
