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

function getOpticalHistory(targetType, targetId, limit = 20) {
  return db.prepare(`
    SELECT * FROM optical_power_history
    WHERE target_type = ? AND target_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(String(targetType).toLowerCase(), parseInt(targetId, 10), Math.min(100, Math.max(1, parseInt(limit, 10) || 20)));
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
async function syncCustomerOpticalPowerFromGenieACS() {
  if (!genieacs || typeof genieacs.getDevices !== 'function') {
    throw new Error('Modul GenieACS belum terpasang atau tidak aktif');
  }

  const devices = await genieacs.getDevices();
  if (!Array.isArray(devices) || devices.length === 0) {
    return { ok: true, syncedCount: 0, message: 'Tidak ada perangkat ditemukan di GenieACS' };
  }

  // Load semua pelanggan aktif
  const customers = db.prepare('SELECT id, name, pppoe_username, phone, genieacs_tag, optical_rx_power FROM customers').all();
  const custMap = new Map();
  customers.forEach(c => {
    if (c.pppoe_username) custMap.set(String(c.pppoe_username).trim().toLowerCase(), c);
    if (c.genieacs_tag) custMap.set(String(c.genieacs_tag).trim().toLowerCase(), c);
    if (c.phone) custMap.set(String(c.phone).trim().replace(/\D/g, ''), c);
  });

  const rxPowerPaths = [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.OpticalPower.RxPower',
    'InternetGatewayDevice.WANDevice.1.WANGponInterfaceConfig.OpticalPower.RxPower',
    'Device.XPON.Interface.1.Stats.RXPower'
  ];

  function extractRx(device) {
    for (const p of rxPowerPaths) {
      const parts = p.split('.');
      let cur = device;
      for (const part of parts) {
        if (!cur) break;
        cur = cur[part];
      }
      if (cur && cur._value !== undefined) {
        let val = parseFloat(cur._value);
        if (!isNaN(val)) {
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
    if (device._id) list.push(String(device._id).toLowerCase());
    if (device._tags && Array.isArray(device._tags)) {
      device._tags.forEach(t => {
        list.push(String(t).toLowerCase());
        if (t.startsWith('pppoe:')) list.push(t.replace('pppoe:', '').toLowerCase());
      });
    }
    // Serial number
    const sn = device._deviceId?._SerialNumber ||
               device.DeviceID?._SerialNumber?._value || 
               device.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value ||
               device.Device?.DeviceInfo?.SerialNumber?._value;
    if (sn) list.push(String(sn).toLowerCase());

    return list;
  }

  let syncedCount = 0;
  const updatedCustomers = [];

  for (const dev of devices) {
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

    if (matchedCust) {
      let status = 'normal';
      if (rx <= -27 || rx >= -8) status = 'critical';
      else if (rx <= -24) status = 'warning';

      // Update pelanggan
      db.prepare(`
        UPDATE customers 
        SET optical_rx_power = ?, optical_status = ?, optical_last_sync = NOW_LOCAL() 
        WHERE id = ?
      `).run(rx, status, matchedCust.id);

      // Log ke optical_power_history jika ada perubahan signifikan (> 0.5 dB) atau pertama kali
      const lastPower = matchedCust.optical_rx_power != null ? parseFloat(matchedCust.optical_rx_power) : null;
      if (lastPower === null || Math.abs(rx - lastPower) >= 0.5) {
        db.prepare(`
          INSERT INTO optical_power_history (
            target_type, target_id, target_name, target_port,
            measured_power_dbm, reference_loss_db, measured_by, notes, created_at
          )
          VALUES ('customer', ?, ?, 'ONU RX', ?, ?, 'GenieACS TR-069', 'Auto-sync background', NOW_LOCAL())
        `).run(
          matchedCust.id,
          matchedCust.name,
          rx,
          lastPower !== null ? parseFloat((rx - lastPower).toFixed(2)) : 0
        );
      }

      syncedCount++;
      updatedCustomers.push({ id: matchedCust.id, name: matchedCust.name, rxPower: rx, status });
    }
  }

  return { ok: true, syncedCount, updatedCustomers };
}

module.exports = {
  logOpticalMeasurement,
  getOpticalHistory,
  snapCableToRoad,
  syncCustomerOpticalPowerFromGenieACS
};
