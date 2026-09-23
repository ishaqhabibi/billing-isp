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
  const stmt = db.prepare(`
    INSERT INTO odps (name, olt_id, odc_id, parent_odp_id, pon_port, port_capacity, lat, lng, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    String(data.name || '').trim(),
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odc_id ? parseInt(data.odc_id) : null,
    data.parent_odp_id ? parseInt(data.parent_odp_id) : null,
    String(data.pon_port || '').trim(),
    data.port_capacity !== undefined && data.port_capacity !== null ? parseInt(data.port_capacity) : 16,
    String(data.lat || '').trim(),
    String(data.lng || '').trim(),
    String(data.description || '').trim()
  );
}

function updateOdp(id, data) {
  const stmt = db.prepare(`
    UPDATE odps 
    SET name = ?, olt_id = ?, odc_id = ?, parent_odp_id = ?, pon_port = ?, port_capacity = ?, lat = ?, lng = ?, description = ?
    WHERE id = ?
  `);
  return stmt.run(
    String(data.name || '').trim(),
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odc_id ? parseInt(data.odc_id) : null,
    data.parent_odp_id ? parseInt(data.parent_odp_id) : null,
    String(data.pon_port || '').trim(),
    data.port_capacity !== undefined && data.port_capacity !== null ? parseInt(data.port_capacity) : 16,
    String(data.lat || '').trim(),
    String(data.lng || '').trim(),
    String(data.description || '').trim(),
    id
  );
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
