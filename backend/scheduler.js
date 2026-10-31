// Папка данных node (том node-persist, data).
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = {
  ensureDataDir,
  DATA_DIR,
};
