const db = require('../config/database');

/**
 * ODP SERVICE
 * Mengelola data Optical Distribution Point (ODP) & hierarki ODC/Parent ODP
 */

function getAllOdps() {
  return db.prepare(`
    SELECT 
      o.*, 
      COALESCE(o.port_capacity, 8) as total_ports,
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
      COALESCE(o.port_capacity, 8) as total_ports,
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

  const rawPortCap = (data.port_capacity !== undefined && data.port_capacity !== '' && data.port_capacity !== null)
    ? data.port_capacity
    : (data.total_ports !== undefined && data.total_ports !== '' && data.total_ports !== null ? data.total_ports : null);
  const finalPortCap = (rawPortCap !== null && !isNaN(parseInt(rawPortCap))) ? parseInt(rawPortCap) : 8;

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
    finalPortCap,
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
  let finalPonPort = data.pon_port ? String(data.pon_port).trim() : null;

  if (odcId) {
    const odc = db.prepare('SELECT id, name, olt_id, pon_port FROM odcs WHERE id = ?').get(odcId);
    if (!odc) throw new Error('ODC Induk yang dipilih tidak valid atau belum terdaftar.');
    if (!finalOltId && odc.olt_id) finalOltId = odc.olt_id;
    if (!finalPonPort && odc.pon_port) finalPonPort = odc.pon_port;
  } else if (parentOdpId) {
    const parent = db.prepare('SELECT id, name, odc_id, olt_id, pon_port FROM odps WHERE id = ?').get(parentOdpId);
    if (!parent) throw new Error('ODP Induk Kaskade tidak valid atau belum terdaftar.');
    if (!finalOdcId && parent.odc_id) finalOdcId = parent.odc_id;
    if (!finalOltId && parent.olt_id) finalOltId = parent.olt_id;
    if (!finalPonPort && parent.pon_port) finalPonPort = parent.pon_port;
  }

  const current = getOdpById(id);
  if (!finalPonPort && current && current.pon_port) {
    finalPonPort = current.pon_port;
  }

  const inputPwr = (data.input_power_dbm !== undefined && data.input_power_dbm !== '' && data.input_power_dbm !== null) ? parseFloat(data.input_power_dbm) : null;
  const outputPwr = (data.output_power_dbm !== undefined && data.output_power_dbm !== '' && data.output_power_dbm !== null) ? parseFloat(data.output_power_dbm) : null;

  const rawPortCap = (data.port_capacity !== undefined && data.port_capacity !== '' && data.port_capacity !== null)
    ? data.port_capacity
    : (data.total_ports !== undefined && data.total_ports !== '' && data.total_ports !== null ? data.total_ports : null);
  const finalPortCap = (rawPortCap !== null && !isNaN(parseInt(rawPortCap)))
    ? parseInt(rawPortCap)
    : (current && current.port_capacity ? current.port_capacity : 8);

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
    String(finalPonPort || '').trim(),
    data.odc_out_port ? parseInt(data.odc_out_port) : null,
    inputPwr,
    outputPwr,
    String(data.splitter_ratio || '1:8').trim(),
    finalPortCap,
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

function getOdpPortSlots(odpId, excludeCustomerId = null) {
  const odp = getOdpById(odpId);
  if (!odp) return null;

  const capacity = Number(odp.port_capacity || odp.total_ports || 8) || 8;
  const customers = db.prepare(`
    SELECT id, name, customer_code, pppoe_username, phone, status,
           COALESCE(odp_port, odp_port_number) as port_num
    FROM customers 
    WHERE odp_id = ? AND (odp_port IS NOT NULL OR odp_port_number IS NOT NULL)
  `).all(odpId);

  const portMap = new Map();
  customers.forEach(c => {
    const pNum = Number(c.port_num);
    if (pNum >= 1 && pNum <= capacity) {
      portMap.set(pNum, c);
    }
  });

  const excludeId = excludeCustomerId ? Number(excludeCustomerId) : null;
  const slots = [];
  let occupiedCount = 0;

  for (let portNum = 1; portNum <= capacity; portNum++) {
    const occupant = portMap.get(portNum) || null;
    const isCurrentCustomer = !!(occupant && excludeId && Number(occupant.id) === excludeId);
    const isOccupied = !!occupant;
    const isUsed = isOccupied && !isCurrentCustomer;

    if (isOccupied) occupiedCount++;

    slots.push({
      portNumber: portNum,
      isOccupied: isOccupied,
      isUsed: isUsed,
      isCurrentCustomer: isCurrentCustomer,
      customer: occupant ? {
        id: occupant.id,
        name: occupant.name,
        customer_code: occupant.customer_code || '',
        pppoe_username: occupant.pppoe_username || '',
        phone: occupant.phone || '',
        status: occupant.status || 'active'
      } : null
    });
  }

  const utilizationPercent = capacity > 0 ? Math.round((occupiedCount / capacity) * 100) : 0;
  let status = 'empty';
  let statusColor = '#10b981'; // Emerald Green
  let statusBadge = 'Kosong';

  if (occupiedCount >= capacity) {
    status = 'full';
    statusColor = '#ef4444'; // Red
    statusBadge = 'Penuh';
  } else if (utilizationPercent >= 75) {
    status = 'warning';
    statusColor = '#f59e0b'; // Amber
    statusBadge = 'Hampir Penuh';
  } else if (occupiedCount > 0) {
    status = 'available';
    statusColor = '#0284c7'; // Blue
    statusBadge = 'Tersedia';
  }

  return {
    odp: {
      id: odp.id,
      name: odp.name,
      capacity: capacity,
      total_ports: capacity,
      odc_id: odp.odc_id,
      odc_name: odp.odc_name,
      splitter_ratio: odp.splitter_ratio || '1:8'
    },
    slots,
    stats: {
      capacity,
      occupiedCount,
      usedCount: occupiedCount,
      availableCount: Math.max(0, capacity - occupiedCount),
      utilizationPercent,
      status,
      statusColor,
      statusBadge
    }
  };
}

function getOdpPortUsage(odpId) {
  const slotsData = getOdpPortSlots(odpId);
  if (!slotsData) return null;
  const { odp, slots, stats } = slotsData;
  const usedPorts = slots.filter(s => s.isOccupied).map(s => String(s.portNumber));
  return {
    odpId: Number(odpId),
    capacity: stats.capacity,
    usedCount: stats.occupiedCount,
    remaining: stats.availableCount,
    usedPorts,
    slots,
    stats
  };
}

module.exports = {
  getAllOdps,
  getOdpById,
  createOdp,
  updateOdp,
  getOdpRelations,
  deleteOdp,
  getOdpPortSlots,
  getOdpPortUsage
};
