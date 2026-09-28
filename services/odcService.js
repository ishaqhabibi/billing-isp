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
  if (!data.olt_id || String(data.olt_id).trim() === '') {
    throw new Error('OLT Induk wajib dipilih! Dalam struktur jaringan ODN, setiap ODC harus terhubung ke perangkat OLT.');
  }
  const oltId = parseInt(data.olt_id);
  const olt = db.prepare('SELECT id, name FROM olts WHERE id = ?').get(oltId);
  if (!olt) {
    throw new Error('OLT yang dipilih tidak valid atau belum terdaftar.');
  }

  const inputPwr = (data.input_power_dbm !== undefined && data.input_power_dbm !== '' && data.input_power_dbm !== null) ? parseFloat(data.input_power_dbm) : null;
  const outputPwr = (data.output_power_dbm !== undefined && data.output_power_dbm !== '' && data.output_power_dbm !== null) ? parseFloat(data.output_power_dbm) : null;
  const stmt = db.prepare(`
    INSERT INTO odcs (name, olt_id, pon_port, input_power_dbm, output_power_dbm, splitter_ratio, total_ports, lat, lng, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    String(data.name || '').trim(),
    oltId,
    String(data.pon_port || '').trim(),
    inputPwr,
    outputPwr,
    String(data.splitter_ratio || '1:4').trim(),
    parseInt(data.total_ports) || 24,
    String(data.lat || '').trim(),
    String(data.lng || '').trim(),
    String(data.description || '').trim()
  );

  if (outputPwr !== null) {
    try {
      db.prepare(`
        INSERT INTO optical_power_history (target_type, target_id, target_name, target_port, measured_power_dbm, measured_by, notes)
        VALUES ('odc', ?, ?, 'Output Splitter', ?, ?, 'Initial measurement ODC')
      `).run(info.lastInsertRowid, String(data.name || '').trim(), outputPwr, data.measured_by || 'Admin');
    } catch (e) {}
  }

  return info;
}

function updateOdc(id, data) {
  if (!data.olt_id || String(data.olt_id).trim() === '') {
    throw new Error('OLT Induk wajib dipilih! Setiap ODC harus terhubung ke OLT.');
  }
  const oltId = parseInt(data.olt_id);
  const olt = db.prepare('SELECT id, name FROM olts WHERE id = ?').get(oltId);
  if (!olt) {
    throw new Error('OLT yang dipilih tidak valid atau belum terdaftar.');
  }

  const inputPwr = (data.input_power_dbm !== undefined && data.input_power_dbm !== '' && data.input_power_dbm !== null) ? parseFloat(data.input_power_dbm) : null;
  const outputPwr = (data.output_power_dbm !== undefined && data.output_power_dbm !== '' && data.output_power_dbm !== null) ? parseFloat(data.output_power_dbm) : null;
  const current = getOdcById(id);

  const stmt = db.prepare(`
    UPDATE odcs 
    SET name = ?, olt_id = ?, pon_port = ?, input_power_dbm = ?, output_power_dbm = ?, splitter_ratio = ?, total_ports = ?, lat = ?, lng = ?, description = ?
    WHERE id = ?
  `);
  const res = stmt.run(
    String(data.name || '').trim(),
    oltId,
    String(data.pon_port || '').trim(),
    inputPwr,
    outputPwr,
    String(data.splitter_ratio || '1:4').trim(),
    parseInt(data.total_ports) || 24,
    String(data.lat || '').trim(),
    String(data.lng || '').trim(),
    String(data.description || '').trim(),
    id
  );

  if (outputPwr !== null && (!current || current.output_power_dbm !== outputPwr)) {
    try {
      db.prepare(`
        INSERT INTO optical_power_history (target_type, target_id, target_name, target_port, measured_power_dbm, reference_loss_db, measured_by, notes)
        VALUES ('odc', ?, ?, 'Output Splitter', ?, ?, ?, ?)
      `).run(
        id,
        String(data.name || '').trim(),
        outputPwr,
        current && current.output_power_dbm != null ? parseFloat((outputPwr - current.output_power_dbm).toFixed(2)) : 0,
        data.measured_by || 'Admin',
        data.notes || 'Update redaman ODC'
      );
    } catch (e) {}
  }

  return res;
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
