const session = require('express-session');
const { logger } = require('../config/logger');

/**
 * Custom SQLite Session Store untuk express-session menggunakan better-sqlite3.
 * Menjamin sesi login admin, kasir, dan pelanggan tidak hilang saat aplikasi/nodemon direstart.
 */
class SqliteSessionStore extends session.Store {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.table = options.table || 'sessions';

    this.initTable();

    // Jalankan pembersihan berkala sesi expired setiap 1 jam
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60 * 60 * 1000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  initTable() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expired INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_${this.table}_expired ON ${this.table}(expired);
      `);
    } catch (err) {
      logger.error(`[SessionStore] Gagal membuat tabel sesi: ${err.message}`);
    }
  }

  cleanupExpired() {
    try {
      const now = Date.now();
      this.db.prepare(`DELETE FROM ${this.table} WHERE expired < ?`).run(now);
    } catch (err) {
      logger.error(`[SessionStore] Gagal membersihkan sesi expired: ${err.message}`);
    }
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare(`SELECT sess, expired FROM ${this.table} WHERE sid = ?`).get(sid);
      if (!row) return callback(null, null);

      if (row.expired && row.expired < Date.now()) {
        this.destroy(sid, () => {});
        return callback(null, null);
      }

      const sess = JSON.parse(row.sess);
      return callback(null, sess);
    } catch (err) {
      logger.error(`[SessionStore] Error membaca session "${sid}": ${err.message}`);
      return callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const maxAge = (sess && sess.cookie && typeof sess.cookie.maxAge === 'number')
        ? sess.cookie.maxAge
        : (24 * 60 * 60 * 1000);
      const expired = Date.now() + maxAge;
      const sessStr = JSON.stringify(sess);

      this.db.prepare(`
        INSERT INTO ${this.table} (sid, sess, expired)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          sess = excluded.sess,
          expired = excluded.expired
      `).run(sid, sessStr, expired);

      if (callback) callback(null);
    } catch (err) {
      logger.error(`[SessionStore] Error menyimpan session "${sid}": ${err.message}`);
      if (callback) callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare(`DELETE FROM ${this.table} WHERE sid = ?`).run(sid);
      if (callback) callback(null);
    } catch (err) {
      logger.error(`[SessionStore] Error menghapus session "${sid}": ${err.message}`);
      if (callback) callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      const maxAge = (sess && sess.cookie && typeof sess.cookie.maxAge === 'number')
        ? sess.cookie.maxAge
        : (24 * 60 * 60 * 1000);
      const expired = Date.now() + maxAge;

      this.db.prepare(`UPDATE ${this.table} SET expired = ? WHERE sid = ?`).run(expired, sid);
      if (callback) callback(null);
    } catch (err) {
      logger.error(`[SessionStore] Error touch session "${sid}": ${err.message}`);
      if (callback) callback(err);
    }
  }
}

module.exports = SqliteSessionStore;
