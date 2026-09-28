const fs = require('fs');
const path = require('path');

let _cachedVersion = null;
let _lastReadTime = 0;

function getAppVersion() {
  const now = Date.now();
  // Cache for 3 seconds to avoid disk thrashing on rapid concurrent requests
  if (_cachedVersion && (now - _lastReadTime < 3000)) {
    return _cachedVersion;
  }
  try {
    const vPath = path.resolve(__dirname, '../version.txt');
    if (fs.existsSync(vPath)) {
      const content = fs.readFileSync(vPath, 'utf8').trim();
      if (content) {
        _cachedVersion = content;
        _lastReadTime = now;
        return _cachedVersion;
      }
    }
  } catch (e) {}
  return _cachedVersion || '1.0.0';
}

module.exports = {
  getAppVersion
};
