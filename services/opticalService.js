const db = require('../config/database');
const axios = require('axios');
const { logger } = require('../config/logger');
let genieacs = null;
try {
  genieacs = require('../config/genieacs');
} catch (e) {
  logger.warn('[OpticalService] GenieACS module not available:', e.message);
}

/**
 * OPTICAL INFRASTRUCTURE SERVICE
 * Mengelola audit trail redaman fiber (dBm), snap jalur kabel ke jalan (OSRM),
 * dan integrasi redaman live ONU dari GenieACS TR-069.
 */

function logOpticalMeasurement(data) {
  const targetType = String(data.target_type || '').toLowerCase().trim();
  const targetId = parseInt(data.target_id, 10);
  const targetName = String(data.target_name || '').trim();
  const targetPort = String(data.target_port || '').trim();
  const measuredPower = parseFloat(data.measured_power_dbm);
  const measuredBy = String(data.measured_by || 'Teknisi').trim();
  const notes = String(data.notes || '').trim();

  if (!targetType || !targetId || isNaN(measuredPower)) {
    throw new Error('Data pengukuran redaman tidak lengkap (target_type, target_id, measured_power_dbm wajib ada)');
  }

  // Cari pengukuran terakhir untuk hitung loss/delta
  const lastRecord = db.prepare(`
    SELECT measured_power_dbm FROM optical_power_history 
    WHERE target_type = ? AND target_id = ? 
    ORDER BY id DESC LIMIT 1
  `).get(targetType, targetId);

  const refLoss = lastRecord ? parseFloat((measuredPower - lastRecord.measured_power_dbm).toFixed(2)) : 0;

  const stmt = db.prepare(`
    INSERT INTO optical_power_history (
      target_type, target_id, target_name, target_port,
      measured_power_dbm, reference_loss_db, measured_by, notes, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW_LOCAL())
  `);
  const info = stmt.run(targetType, targetId, targetName, targetPort, measuredPower, refLoss, measuredBy, notes);

  // Update nilai redaman terkini pada tabel entitas bersangkutan
  if (targetType === 'odc') {
    db.prepare('UPDATE odcs SET output_power_dbm = ? WHERE id = ?').run(measuredPower, targetId);
  } else if (targetType === 'odp') {
    db.prepare('UPDATE odps SET output_power_dbm = ? WHERE id = ?').run(measuredPower, targetId);
  } else if (targetType === 'customer') {
    let status = 'normal';
    if (measuredPower <= -27 || measuredPower >= -8) status = 'critical';
    else if (measuredPower <= -24) status = 'warning';

    db.prepare(`
      UPDATE customers 
      SET optical_rx_power = ?, optical_status = ?, optical_last_sync = NOW_LOCAL() 
      WHERE id = ?
    `).run(measuredPower, status, targetId);
  }

  return { id: info.lastInsertRowid, targetType, targetId, measuredPower, refLoss };
}

function getOpticalHistory(targetType, targetId, limit = 100, days = null) {
  const safeType = String(targetType).toLowerCase();
  const safeId = parseInt(targetId, 10);
  const safeLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const safeDays = (days !== null && days !== undefined && days !== '') ? parseInt(days, 10) : 0;

  if (safeDays > 0) {
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM optical_power_history
        WHERE target_type = ? AND target_id = ?
          AND datetime(created_at) >= datetime(NOW_LOCAL(), ?)
        ORDER BY id DESC
        LIMIT ?
      ) ORDER BY id ASC
    `).all(safeType, safeId, `-${safeDays} days`, safeLimit);
  }

  return db.prepare(`
    SELECT * FROM optical_power_history
    WHERE target_type = ? AND target_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(safeType, safeId, safeLimit);
}

/**
 * SNAP KABEL KE JALAN DENGAN OSRM ROUTING API
 * Mengambil koordinat lekukan jalan dari OpenStreetMap (OSRM)
 * Menghasilkan rute kabel yang mengikuti jalan / gang riil.
 */
async function snapCableToRoad(startLat, startLng, endLat, endLng) {
  const sLat = parseFloat(startLat);
  const sLng = parseFloat(startLng);
  const eLat = parseFloat(endLat);
  const eLng = parseFloat(endLng);

  if (isNaN(sLat) || isNaN(sLng) || isNaN(eLat) || isNaN(eLng)) {
    throw new Error('Koordinat awal atau akhir tidak valid');
  }

  const fallbackDirect = [[sLat, sLng], [eLat, eLng]];

  try {
    // Panggil OSRM Foot Profile (karena jalur tiang fiber berada di tepi jalan/gang pejalan kaki)
    const url = `https://router.project-osrm.org/route/v1/foot/${sLng},${sLat};${eLng},${eLat}?overview=full&geometries=geojson`;
    const res = await axios.get(url, { timeout: 3500 });

    if (res.data && res.data.routes && res.data.routes.length > 0) {
      const coords = res.data.routes[0].geometry.coordinates; // [[lng, lat], ...]
      if (Array.isArray(coords) && coords.length > 0) {
        // Konversi ke format Leaflet [[lat, lng], ...]
        return coords.map(([lng, lat]) => [lat, lng]);
      }
    }
    return fallbackDirect;
  } catch (err) {
    logger.warn('[OSRM Routing] Gagal snap ke jalan, menggunakan garis langsung: ' + err.message);
    return fallbackDirect;
  }
}

/**
 * SINKRONISASI REDAMAN PELANGGAN DARI GENIEACS TR-069
 */
const RX_POWER_PATHS = [
  'VirtualParameters.RXPower',
  'VirtualParameters.redaman',
  'InternetGatewayDevice.X_FH_PON_MANAGE.RxPower',
  'InternetGatewayDevice.X_FH_PON_MANAGE.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FH_WANGponLinkConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FH_WANGponLinkConfig.RxPower',
  'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANOAM.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_OpticalSignal.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RxPower',
  'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RxPower',
  'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RxPower',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_OpticalSignal.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_OpticalSignal.RxPower',
  'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RxPower',
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RxPower',
  'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.OpticalPower.RxPower',
  'InternetGatewayDevice.WANDevice.1.WANGponInterfaceConfig.OpticalPower.RxPower',
  'Device.Optical.Interface.1.OpticalSignalLevel',
  'Device.XPON.Interface.1.Stats.RXPower'
];

const OPTICAL_PROJECTION_FIELDS = [
  '_id',
  '_tags',
  '_lastInform',
  '_deviceId',
  'DeviceID._SerialNumber',
  'InternetGatewayDevice.DeviceInfo.SerialNumber',
  'Device.DeviceInfo.SerialNumber',
  'VirtualParameters.pppoeUsername',
  'VirtualParameters.pppUsername',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
  'Device.PPP.Interface.1.Username',
  ...RX_POWER_PATHS
];

async function syncCustomerOpticalPowerFromGenieACS(options = {}) {
  if (!genieacs || typeof genieacs.getDevices !== 'function') {
    throw new Error('Modul GenieACS belum terpasang atau tidak aktif');
  }

  const maxStaleHours = options.maxStaleHours !== undefined ? Number(options.maxStaleHours) : 24;
  const deadbandDb = options.deadbandDb !== undefined ? Number(options.deadbandDb) : 0.3;
  const heartbeatHours = options.heartbeatHours !== undefined ? Number(options.heartbeatHours) : 6;

  const devices = await genieacs.getDevices(null, OPTICAL_PROJECTION_FIELDS);
  if (!Array.isArray(devices) || devices.length === 0) {
    return {
      ok: true,
      syncedCount: 0,
      loggedCount: 0,
      skippedStaleCount: 0,
      totalDevicesFetched: 0,
      updatedCustomers: [],
      message: 'Tidak ada perangkat ditemukan di GenieACS'
    };
  }

  // Load semua pelanggan + histori terakhir dalam satu query agar bebas N+1
  const customers = db.prepare(`
    SELECT id, name, pppoe_username, phone, genieacs_tag, ont_sn, optical_rx_power, optical_status
    FROM customers
  `).all();
  const custMap = new Map();
  customers.forEach(c => {
    if (c.pppoe_username) custMap.set(String(c.pppoe_username).trim().toLowerCase(), c);
    if (c.genieacs_tag) custMap.set(String(c.genieacs_tag).trim().toLowerCase(), c);
    if (c.ont_sn) custMap.set(String(c.ont_sn).trim().toLowerCase(), c);
    if (c.phone) custMap.set(String(c.phone).trim().replace(/\D/g, ''), c);
  });

  const latestHistoryRows = db.prepare(`
    SELECT o1.target_id, o1.measured_power_dbm, o1.created_at
    FROM optical_power_history o1
    INNER JOIN (
      SELECT target_id, MAX(id) AS max_id
      FROM optical_power_history
      WHERE target_type = 'customer'
      GROUP BY target_id
    ) o2 ON o1.id = o2.max_id
  `).all();
  const latestHistoryMap = new Map(latestHistoryRows.map(r => [Number(r.target_id), r]));

  function getNestedValue(device, pathStr) {
    const parts = pathStr.split('.');
    let cur = device;
    for (const part of parts) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur && cur._value !== undefined ? cur._value : cur;
  }

  function extractRx(device) {
    for (const p of RX_POWER_PATHS) {
      const parts = p.split('.');
      let cur = device;
      for (const part of parts) {
        if (!cur) break;
        cur = cur[part];
      }
      if (cur && cur._value !== undefined) {
        let val = parseFloat(cur._value);
        if (Number.isFinite(val)) {
          // Normalisasi skala jika perangkat mengembalikan nilai integer tanpa desimal (misal 2140 = -21.4 dBm)
          if (val > 100) val = -(val / 100);
          else if (val > 0 && val < 100) val = -val;
          return parseFloat(val.toFixed(2));
        }
      }
    }
    return null;
  }

  function getDeviceIdentifiers(device) {
    const list = [];
    if (device._id) list.push(String(device._id).trim().toLowerCase());
    if (device._tags && Array.isArray(device._tags)) {
      device._tags.forEach(t => {
        const cleanTag = String(t).trim().toLowerCase();
        list.push(cleanTag);
        if (cleanTag.startsWith('pppoe:')) list.push(cleanTag.replace('pppoe:', '').trim());
      });
    }

    const pppCandidates = [
      getNestedValue(device, 'VirtualParameters.pppoeUsername'),
      getNestedValue(device, 'VirtualParameters.pppUsername'),
      getNestedValue(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username'),
      getNestedValue(device, 'Device.PPP.Interface.1.Username')
    ];
    pppCandidates.forEach(u => {
      if (u && typeof u === 'string') list.push(u.trim().toLowerCase());
    });

    const sn = device._deviceId?._SerialNumber ||
               device.DeviceID?._SerialNumber?._value ||
               device.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value ||
               device.Device?.DeviceInfo?.SerialNumber?._value;
    if (sn) list.push(String(sn).trim().toLowerCase());

    return list;
  }

  const updates = [];
  const historyInserts = [];
  const updatedCustomers = [];
  const seenCustomerIds = new Set();
  let skippedStaleCount = 0;

  for (const dev of devices) {
    if (maxStaleHours > 0 && dev._lastInform) {
      const informMs = new Date(dev._lastInform).getTime();
      if (Number.isFinite(informMs) && (Date.now() - informMs) > maxStaleHours * 3600 * 1000) {
        skippedStaleCount++;
        continue;
      }
    }

    const rx = extractRx(dev);
    if (rx === null) continue;

    const ids = getDeviceIdentifiers(dev);
    let matchedCust = null;
    for (const idStr of ids) {
      if (custMap.has(idStr)) {
        matchedCust = custMap.get(idStr);
        break;
      }
    }

    if (!matchedCust || seenCustomerIds.has(matchedCust.id)) continue;
    seenCustomerIds.add(matchedCust.id);

    let status = 'normal';
    if (rx <= -27 || rx >= -8) status = 'critical';
    else if (rx <= -24) status = 'warning';

    updates.push({ id: matchedCust.id, rx, status });

    const prevHist = latestHistoryMap.get(Number(matchedCust.id));
    const prevRx = prevHist
      ? parseFloat(prevHist.measured_power_dbm)
      : (matchedCust.optical_rx_power != null ? parseFloat(matchedCust.optical_rx_power) : null);
    const prevStatus = matchedCust.optical_status || 'normal';
    const deltaDb = (prevRx !== null && Number.isFinite(prevRx)) ? parseFloat((rx - prevRx).toFixed(2)) : 0;

    let elapsedHours = Infinity;
    if (prevHist && prevHist.created_at) {
      const parsedMs = new Date(String(prevHist.created_at).replace(' ', 'T')).getTime();
      if (Number.isFinite(parsedMs)) {
        elapsedHours = (Date.now() - parsedMs) / (3600 * 1000);
      }
    }

    const isFirstLog = !prevHist;
    const isSignificantChange = prevRx === null || !Number.isFinite(prevRx) || Math.abs(rx - prevRx) >= deadbandDb;
    const isStatusChanged = prevStatus !== status;
    const isHeartbeatDue = elapsedHours >= heartbeatHours;

    if (isFirstLog || isSignificantChange || isStatusChanged || isHeartbeatDue) {
      let reason = 'Heartbeat 6 jam';
      if (isFirstLog) reason = 'Pencatatan awal GenieACS';
      else if (isStatusChanged) reason = `Perubahan status (${prevStatus} -> ${status})`;
      else if (isSignificantChange) reason = `Perubahan redaman ${deltaDb >= 0 ? '+' : ''}${deltaDb} dB`;

      historyInserts.push({
        targetId: matchedCust.id,
        targetName: matchedCust.name,
        rx,
        deltaDb,
        notes: reason
      });
    }

    updatedCustomers.push({ id: matchedCust.id, name: matchedCust.name, rxPower: rx, status, deltaDb });
  }

  const updateStmt = db.prepare(`
    UPDATE customers
    SET optical_rx_power = ?, optical_status = ?, optical_last_sync = NOW_LOCAL()
    WHERE id = ?
  `);
  const insertHistStmt = db.prepare(`
    INSERT INTO optical_power_history (
      target_type, target_id, target_name, target_port,
      measured_power_dbm, reference_loss_db, measured_by, notes, created_at
    )
    VALUES ('customer', ?, ?, 'ONU RX', ?, ?, 'GenieACS TR-069', ?, NOW_LOCAL())
  `);

  const runBatch = db.transaction(() => {
    for (const u of updates) {
      updateStmt.run(u.rx, u.status, u.id);
    }
    for (const h of historyInserts) {
      insertHistStmt.run(h.targetId, h.targetName, h.rx, h.deltaDb, h.notes);
    }
  });
  runBatch();

  return {
    ok: true,
    syncedCount: updates.length,
    loggedCount: historyInserts.length,
    skippedStaleCount,
    totalDevicesFetched: devices.length,
    updatedCustomers
  };
}

/**
 * Ambil daftar pelanggan dengan indikasi penurunan redaman / status warning-critical
 */
function getDegradedCustomers(options = {}) {
  const hours = Math.max(1, parseInt(options.hours, 10) || 24);
  const dropThresholdDb = Number(options.dropThresholdDb) || 2.0;
  const limit = Math.min(200, Math.max(1, parseInt(options.limit, 10) || 50));

  const rows = db.prepare(`
    SELECT
      c.id, c.name, c.pppoe_username, c.phone, c.area,
      c.optical_rx_power, c.initial_rx_power, c.optical_status, c.optical_last_sync,
      (
        SELECT MAX(measured_power_dbm)
        FROM optical_power_history h
        WHERE h.target_type = 'customer' AND h.target_id = c.id
          AND datetime(h.created_at) >= datetime(NOW_LOCAL(), ?)
      ) AS best_rx_window
    FROM customers c
    WHERE c.optical_rx_power IS NOT NULL
      AND (
        c.optical_status IN ('warning', 'critical')
        OR (c.initial_rx_power IS NOT NULL AND c.optical_rx_power <= c.initial_rx_power - ?)
        OR EXISTS (
          SELECT 1 FROM optical_power_history h
          WHERE h.target_type = 'customer' AND h.target_id = c.id
            AND datetime(h.created_at) >= datetime(NOW_LOCAL(), ?)
            AND h.measured_power_dbm >= c.optical_rx_power + ?
        )
      )
    ORDER BY
      CASE WHEN c.optical_status = 'critical' THEN 0 WHEN c.optical_status = 'warning' THEN 1 ELSE 2 END,
      c.optical_rx_power ASC
    LIMIT ?
  `).all(`-${hours} hours`, dropThresholdDb, `-${hours} hours`, dropThresholdDb, limit);

  return rows.map(r => {
    const currentRx = r.optical_rx_power != null ? parseFloat(r.optical_rx_power) : null;
    const initRx = r.initial_rx_power != null ? parseFloat(r.initial_rx_power) : null;
    const bestWindow = r.best_rx_window != null ? parseFloat(r.best_rx_window) : null;
    return {
      ...r,
      drop_from_initial_db: (currentRx !== null && initRx !== null) ? parseFloat((currentRx - initRx).toFixed(2)) : null,
      recent_drop_db: (currentRx !== null && bestWindow !== null) ? parseFloat((currentRx - bestWindow).toFixed(2)) : null
    };
  });
}

/**
 * Hapus log histori redaman yang lebih tua dari retentionDays hari agar DB SQLite tetap ringan
 */
function cleanupOldOpticalHistory(retentionDays = 90) {
  const days = Math.max(7, parseInt(retentionDays, 10) || 90);
  const info = db.prepare(`
    DELETE FROM optical_power_history
    WHERE datetime(created_at) < datetime(NOW_LOCAL(), ?)
  `).run(`-${days} days`);
  return { ok: true, deletedCount: info.changes, retentionDays: days };
}

module.exports = {
  logOpticalMeasurement,
  getOpticalHistory,
  snapCableToRoad,
  syncCustomerOpticalPowerFromGenieACS,
  getDegradedCustomers,
  cleanupOldOpticalHistory,
  OPTICAL_PROJECTION_FIELDS
};
