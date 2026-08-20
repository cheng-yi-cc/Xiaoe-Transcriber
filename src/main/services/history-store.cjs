const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class HistoryStore {
  constructor(filePath, limit = 100) {
    this.filePath = filePath;
    this.limit = limit;
    this.entries = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed.slice(0, this.limit) : [];
    } catch {
      return [];
    }
  }

  list() {
    return structuredClone(this.entries);
  }

  get(id) {
    const entry = this.entries.find((item) => item.id === id);
    return entry ? structuredClone(entry) : null;
  }

  add(entry) {
    const normalized = {
      id: entry.id || crypto.randomUUID(),
      title: String(entry.title || '小鹅通视频').slice(0, 160),
      sourceUrl: String(entry.sourceUrl || ''),
      resultDirectory: path.resolve(String(entry.resultDirectory || '')),
      completedAt: entry.completedAt || new Date().toISOString(),
      modelId: String(entry.modelId || '')
    };
    this.entries = [normalized, ...this.entries.filter((item) => item.resultDirectory !== normalized.resultDirectory)]
      .slice(0, this.limit);
    this.save();
    return structuredClone(normalized);
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.filePath);
  }
}

module.exports = { HistoryStore };
