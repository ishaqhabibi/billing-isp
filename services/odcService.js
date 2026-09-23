const db = require('../config/database');

/**
 * ODC SERVICE
 * Mengelola data Optical Distribution Cabinet (ODC) & relasi downstream ODP
 */

function getAllOdcs() {
  return db.prepare(`
    SELECT 
      odc.*, 
      olt.name as olt_name,
      (SELECT COUNT(*) FROM odps WHERE odc_id = odc.id) as connected_odp_count
    FROM odcs odc
    LEFT JOIN olts olt ON odc.olt_id = olt.id
    ORDER BY odc.name ASC
  `).all();
}

function getOdcById(id) {
  return db.prepare(`
    SELECT odc.*, olt.name as olt_name 
    FROM odcs odc 
    LEFT JOIN olts olt ON odc.olt_id = olt.id 
    WHERE odc.id = ?
  `).get(id);
}

function createOdc(data) {
  const stmt = db.prepare(`
    INSERT INTO odcs (name, olt_id, lat, lng, description)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(
    String(data.name || '').trim(),
    data.olt_id ? parseInt(data.olt_id) : null,
    String(data.lat || '').trim(),
    String(data.lng || '').trim(),
    String(data.description || '').trim()
  );
}

function updateOdc(id, data) {
  const stmt = db.prepare(`
    UPDATE odcs 
    SET name = ?, olt_id = ?, lat = ?, lng = ?, description = ?
    WHERE id = ?
  `);
  return stmt.run(
    String(data.name || '').trim(),
    data.olt_id ? parseInt(data.olt_id) : null,
    String(data.lat || '').trim(),
    String(data.lng || '').trim(),
    String(data.description || '').trim(),
    id
  );
}

function getOdcRelations(id) {
  const odpList = db.prepare(`
    SELECT id, name, lat, lng 
    FROM odps 
    WHERE odc_id = ?
    ORDER BY name ASC
  `).all(id);
  return {
    odpCount: odpList.length,
    odps: odpList
  };
}

function deleteOdc(id, action = 'unlink', targetOdcId = null) {
  const targetId = targetOdcId ? parseInt(targetOdcId) : null;
  const odcId = parseInt(id);

  db.transaction(() => {
    if (action === 'migrate' && targetId && targetId !== odcId) {
      // Migrasi semua ODP anak ke ODC tujuan
      db.prepare('UPDATE odps SET odc_id = ? WHERE odc_id = ?').run(targetId, odcId);
    } else {
      // Unlink: Lepaskan sambungan ODP anak (set odc_id = NULL)
      db.prepare('UPDATE odps SET odc_id = NULL WHERE odc_id = ?').run(odcId);
    }
    // Hapus data ODC
    db.prepare('DELETE FROM odcs WHERE id = ?').run(odcId);
  })();

  return { ok: true };
}

module.exports = {
  getAllOdcs,
  getOdcById,
  createOdc,
  updateOdc,
  getOdcRelations,
  deleteOdc
};
