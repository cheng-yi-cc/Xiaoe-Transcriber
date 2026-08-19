const fs = require('node:fs');
const path = require('node:path');

class SettingsStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = structuredClone(defaults);
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { ...structuredClone(this.defaults), ...parsed };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  getAll() {
    return structuredClone(this.data);
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.filePath);
    return this.getAll();
  }
}

module.exports = { SettingsStore };
