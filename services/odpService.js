const db = require('../config/database');

/**
 * ODP SERVICE
 * Mengelola data Optical Distribution Point (ODP) & hierarki ODC/Parent ODP
 */

function getAllOdps() {
  return db.prepare(`
    SELECT 
      o.*, 
      olt.name as olt_name,
      odc.name as odc_name,
      podp.name as parent_odp_name,
      (SELECT COUNT(*) FROM customers WHERE odp_id = o.id) as connected_customer_count,
      (SELECT COUNT(*) FROM odps WHERE parent_odp_id = o.id) as connected_child_odp_count
    FROM odps o 
    LEFT JOIN olts olt ON o.olt_id = olt.id 
    LEFT JOIN odcs odc ON o.odc_id = odc.id
    LEFT JOIN odps podp ON o.parent_odp_id = podp.id
    ORDER BY o.name ASC
  `).all();
}

function getOdpById(id) {
  return db.prepare(`
    SELECT 
      o.*, 
      olt.name as olt_name,
      odc.name as odc_name,
      podp.name as parent_odp_name
    FROM odps o 
    LEFT JOIN olts olt ON o.olt_id = olt.id 
    LEFT JOIN odcs odc ON o.odc_id = odc.id
    LEFT JOIN odps podp ON o.parent_odp_id = podp.id
    WHERE o.id = ?
  `).get(id);
}

function createOdp(data) {
  const odcId = data.odc_id ? parseInt(data.odc_id) : null;
  const parentOdpId = data.parent_odp_id ? parseInt(data.parent_odp_id) : null;

  if (!odcId && !parentOdpId) {
    throw new Error('ODC Induk wajib dipilih! Dalam struktur jaringan ODN, setiap ODP harus terhubung ke ODC atau ODP Kaskade.');
  }

  let finalOdcId = odcId;
  let finalOltId = data.olt_id ? parseInt(data.olt_id) : null;

  if (odcId) {
    const odc = db.prepare('SELECT id, name, olt_id FROM odcs WHERE id = ?').get(odcId);
    if (!odc) throw new Error('ODC Induk yang dipilih tidak valid atau belum terdaftar.');
    if (!finalOltId && odc.olt_id) finalOltId = odc.olt_id;
  } else if (parentOdpId) {
    const parent = db.prepare('SELECT id, name, odc_id, olt_id FROM odps WHERE id = ?').get(parentOdpId);
    if (!parent) throw new Error('ODP Induk Kaskade tidak valid atau belum terdaftar.');
    if (!finalOdcId && parent.odc_id) finalOdcId = parent.odc_id;
    if (!finalOltId && parent.olt_id) finalOltId = parent.olt_id;
  }

  const inputPwr = (data.input_power_dbm !== undefined && data.input_power_dbm !== '' && data.input_power_dbm !== null) ? parseFloat(data.input_power_dbm) : null;
  const outputPwr = (data.output_power_dbm !== undefined && data.output_power_dbm !== '' && data.output_power_dbm !== null) ? parseFloat(data.output_power_dbm) : null;

  const stmt = db.prepare(`
    INSERT INTO odps (name, olt_id, odc_id, parent_odp_id, pon_port, odc_out_port, input_power_dbm, output_power_dbm, splitter_ratio, port_capacity, lat, lng, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    String(data.name || '').trim(),
    finalOltId,
    finalOdcId,
    parentOdpId,
    String(data.pon_port || '').trim(),
    data.odc_out_port ? parseInt(data.odc_out_port) : null,
    inputPwr,
    outputPwr,
    String(data.splitter_ratio || '1:8').trim(),
    data.port_capacity !== undefined && data.port_capacity !== null ? parseInt(data.port_capacity) : 16,
    String(data.lat || '').trim(),
    String(data.lng || '').trim(),
    String(data.description || '').trim()
  );

  if (outputPwr !== null) {
    try {
      db.prepare(`
        INSERT INTO optical_power_history (target_type, target_id, target_name, target_port, measured_power_dbm, measured_by, notes)
        VALUES ('odp', ?, ?, 'Output ODP', ?, ?, 'Initial measurement ODP')
      `).run(info.lastInsertRowid, String(data.name || '').trim(), outputPwr, data.measured_by || 'Admin');
    } catch (e) {}
  }

  return info;
}

function updateOdp(id, data) {
  const odcId = data.odc_id ? parseInt(data.odc_id) : null;
  const parentOdpId = data.parent_odp_id ? parseInt(data.parent_odp_id) : null;

  if (!odcId && !parentOdpId) {
    throw new Error('ODC Induk wajib dipilih! Setiap ODP harus terhubung ke ODC atau ODP Kaskade.');
  }

  let finalOdcId = odcId;
  let finalOltId = data.olt_id ? parseInt(data.olt_id) : null;

  if (odcId) {
    const odc = db.prepare('SELECT id, name, olt_id FROM odcs WHERE id = ?').get(odcId);
    if (!odc) throw new Error('ODC Induk yang dipilih tidak valid atau belum terdaftar.');
    if (!finalOltId && odc.olt_id) finalOltId = odc.olt_id;
  } else if (parentOdpId) {
    const parent = db.prepare('SELECT id, name, odc_id, olt_id FROM odps WHERE id = ?').get(parentOdpId);
    if (!parent) throw new Error('ODP Induk Kaskade tidak valid atau belum terdaftar.');
    if (!finalOdcId && parent.odc_id) finalOdcId = parent.odc_id;
    if (!finalOltId && parent.olt_id) finalOltId = parent.olt_id;
  }

  const inputPwr = (data.input_power_dbm !== undefined && data.input_power_dbm !== '' && data.input_power_dbm !== null) ? parseFloat(data.input_power_dbm) : null;
  const outputPwr = (data.output_power_dbm !== undefined && data.output_power_dbm !== '' && data.output_power_dbm !== null) ? parseFloat(data.output_power_dbm) : null;
  const current = getOdpById(id);

  const stmt = db.prepare(`
    UPDATE odps 
    SET name = ?, olt_id = ?, odc_id = ?, parent_odp_id = ?, pon_port = ?, odc_out_port = ?, input_power_dbm = ?, output_power_dbm = ?, splitter_ratio = ?, port_capacity = ?, lat = ?, lng = ?, description = ?
    WHERE id = ?
  `);
  const res = stmt.run(
    String(data.name || '').trim(),
    finalOltId,
    finalOdcId,
    parentOdpId,
    String(data.pon_port || '').trim(),
    data.odc_out_port ? parseInt(data.odc_out_port) : null,
    inputPwr,
    outputPwr,
    String(data.splitter_ratio || '1:8').trim(),
    data.port_capacity !== undefined && data.port_capacity !== null ? parseInt(data.port_capacity) : 16,
    String(data.lat || '').trim(),
    String(data.lng || '').trim(),
    String(data.description || '').trim(),
    id
  );

  if (outputPwr !== null && (!current || current.output_power_dbm !== outputPwr)) {
    try {
      db.prepare(`
        INSERT INTO optical_power_history (target_type, target_id, target_name, target_port, measured_power_dbm, reference_loss_db, measured_by, notes)
        VALUES ('odp', ?, ?, 'Output ODP', ?, ?, ?, ?)
      `).run(
        id,
        String(data.name || '').trim(),
        outputPwr,
        current && current.output_power_dbm != null ? parseFloat((outputPwr - current.output_power_dbm).toFixed(2)) : 0,
        data.measured_by || 'Admin',
        data.notes || 'Update redaman ODP'
      );
    } catch (e) {}
  }

  return res;
}

function getOdpRelations(id) {
  const customerList = db.prepare(`
    SELECT id, name, pppoe_username, phone, lat, lng 
    FROM customers 
    WHERE odp_id = ?
    ORDER BY name ASC
  `).all(id);

  const childOdpList = db.prepare(`
    SELECT id, name, lat, lng 
    FROM odps 
    WHERE parent_odp_id = ?
    ORDER BY name ASC
  `).all(id);

  return {
    customerCount: customerList.length,
    childOdpCount: childOdpList.length,
    customers: customerList,
    childOdps: childOdpList
  };
}

function deleteOdp(id, action = 'unlink', targetOdpId = null) {
  const targetId = targetOdpId ? parseInt(targetOdpId) : null;
  const odpId = parseInt(id);

  db.transaction(() => {
    if (action === 'migrate' && targetId && targetId !== odpId) {
      // Pindahkan seluruh pelanggan terhubung ke ODP target baru
      db.prepare('UPDATE customers SET odp_id = ? WHERE odp_id = ?').run(targetId, odpId);
      // Pindahkan sub-ODP anak ke ODP target baru
      db.prepare('UPDATE odps SET parent_odp_id = ? WHERE parent_odp_id = ?').run(targetId, odpId);
    } else {
      // Unlink: Lepaskan sambungan pelanggan (set odp_id = NULL) tanpa menghapus pelanggan
      db.prepare('UPDATE customers SET odp_id = NULL WHERE odp_id = ?').run(odpId);
      // Lepaskan sambungan sub-ODP anak
      db.prepare('UPDATE odps SET parent_odp_id = NULL WHERE parent_odp_id = ?').run(odpId);
    }
    // Hapus data fisik ODP
    db.prepare('DELETE FROM odps WHERE id = ?').run(odpId);
  })();

  return { ok: true };
}

function getOdpPortUsage(odpId) {
  const odp = getOdpById(odpId);
  if (!odp) return null;
  const usedRaw = db.prepare("SELECT pon_port FROM customers WHERE odp_id = ? AND pon_port IS NOT NULL AND TRIM(pon_port) != ''").all(odpId);
  const usedPorts = Array.from(new Set(usedRaw.map(r => String(r.pon_port).trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'id-ID', { numeric: true }));
  const capacity = Number(odp.port_capacity || 16) || 16;
  const usedCount = usedPorts.length;
  const remaining = Math.max(0, capacity - usedCount);
  return { odpId: Number(odpId), capacity, usedCount, remaining, usedPorts };
}

module.exports = {
  getAllOdps,
  getOdpById,
  createOdp,
  updateOdp,
  getOdpRelations,
  deleteOdp,
  getOdpPortUsage
};
