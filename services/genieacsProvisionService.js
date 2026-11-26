const db = require('../config/database');
const { logger } = require('../config/logger');
const genieacs = require('../config/genieacs');

const DEFAULT_FIBERHOME_VLAN = 100;
const DEFAULT_FIBERHOME_LAN_BIND =
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,' +
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2,' +
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3,' +
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4,' +
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1,' +
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2,' +
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3,' +
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4,' +
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5,' +
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6,' +
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7,' +
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8';

const FIBERHOME_APPLICATION_LIST = 'HTTP:80,HTTPS:443,Telnet:23,SSH:22,FTP:21,SNMP:161,ICMP';

/**
 * Parameter ACL standar sesuai konfigurasi brg1101 (FiberHome HG6145D2)
 */
function buildFiberhomeAclParameterValues() {
  return [
    ['InternetGatewayDevice.X_FH_ACL.Enable', '1', 'xsd:string'],
    ['InternetGatewayDevice.X_FH_ACL.AclMode', '0', 'xsd:string'],
    ['InternetGatewayDevice.X_FH_ACL.ApplicationList', FIBERHOME_APPLICATION_LIST, 'xsd:string'],
    ['InternetGatewayDevice.X_FH_ACL.Rule.1.Enable', 1, 'xsd:unsignedInt'],
    ['InternetGatewayDevice.X_FH_ACL.Rule.1.Direction', 1, 'xsd:unsignedInt'],
    ['InternetGatewayDevice.X_FH_ACL.Rule.1.Protocol', 'ALL', 'xsd:string'],
    ['InternetGatewayDevice.X_FH_ACL.Rule.1.StartIp', '', 'xsd:string'],
    ['InternetGatewayDevice.X_FH_ACL.Rule.1.EndIp', '', 'xsd:string']
  ];
}

function isTr069WanConnection(wcdObj) {
  if (!wcdObj || typeof wcdObj !== 'object') return false;
  const checkConnMap = (connMap) => {
    if (!connMap || typeof connMap !== 'object') return false;
    for (const k of Object.keys(connMap).filter(x => /^\d+$/.test(x))) {
      const c = connMap[k];
      if (!c || typeof c !== 'object') continue;
      const name = String(c.Name?._value || '').toUpperCase();
      const svc = String(c.X_FH_ServiceList?._value || '').toUpperCase();
      const vlan = c.VLANID?._value;
      if (name.includes('TR069') || svc.includes('TR069') || Number(vlan) === 20) {
        return true;
      }
    }
    return false;
  };
  return checkConnMap(wcdObj.WANIPConnection) || checkConnMap(wcdObj.WANPPPConnection);
}

/**
 * Analisis slot WANConnectionDevice pada ONT FiberHome HG6145D2 secara dinamis:
 * - Mengunci WCD yang berisi TR069 (VLAN 20) agar tidak pernah tersentuh.
 * - Mendeteksi apakah WANPPPConnection berada di WCD.1 atau WCD.2 (urutan bisa berbeda).
 * - Mengumpulkan username PPPoE eksisting untuk mencegah penimpaan.
 */
function inspectFiberhomeWanSlots(device) {
  const wcdRoot = device?.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice || {};
  const numericWcdKeys = Object.keys(wcdRoot)
    .filter(k => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));

  const tr069Indices = [];
  const pppSlots = [];

  for (const wcdIdx of numericWcdKeys) {
    const wcdObj = wcdRoot[wcdIdx];
    if (isTr069WanConnection(wcdObj)) {
      tr069Indices.push(Number(wcdIdx));
      continue;
    }

    const pppMap = wcdObj?.WANPPPConnection || {};
    const pppKeys = Object.keys(pppMap)
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));

    for (const pppIdx of pppKeys) {
      const pppObj = pppMap[pppIdx];
      if (!pppObj || typeof pppObj !== 'object') continue;
      pppSlots.push({
        wcdIndex: Number(wcdIdx),
        pppIndex: Number(pppIdx),
        existingUsername: String(pppObj.Username?._value || '').trim(),
        name: String(pppObj.Name?._value || '').trim(),
        vlan: pppObj.VLANID?._value != null ? Number(pppObj.VLANID._value) : null,
        serviceList: String(pppObj.X_FH_ServiceList?._value || '').trim(),
        lanInterface: String(pppObj.X_FH_LanInterface?._value || '').trim()
      });
    }
  }

  const maxWcdIndex = numericWcdKeys.length > 0 ? Math.max(...numericWcdKeys.map(Number)) : 0;

  return {
    totalWcdCount: numericWcdKeys.length,
    tr069Indices,
    pppSlots,
    nextAvailableWcdIndex: maxWcdIndex + 1
  };
}

function isFiberhomeAclAlreadyMatching(device) {
  const acl = device?.InternetGatewayDevice?.X_FH_ACL;
  if (!acl || typeof acl !== 'object') return false;
  const r1 = acl.Rule?.['1'];
  if (!r1 || typeof r1 !== 'object') return false;
  return (
    String(acl.Enable?._value ?? '') === '1' &&
    String(acl.AclMode?._value ?? '') === '0' &&
    Number(r1.Enable?._value) === 1 &&
    Number(r1.Direction?._value) === 1 &&
    String(r1.Protocol?._value || '').toUpperCase() === 'ALL'
  );
}

async function findGenieacsDeviceByIdentifiers(identifiers = []) {
  const servers = genieacs.getAllACSServers();
  if (!Array.isArray(servers) || servers.length === 0) return null;

  const cleanIds = identifiers.map(s => String(s || '').trim()).filter(Boolean);
  if (cleanIds.length === 0) return null;

  for (const srv of servers) {
    const ax = genieacs.createAxiosInstance(srv);
    for (const token of cleanIds) {
      const orClauses = [
        { _id: token },
        { _tags: token },
        { _tags: token.toUpperCase() },
        { '_deviceId._SerialNumber': token },
        { '_deviceId._SerialNumber': token.toUpperCase() },
        { 'InternetGatewayDevice.DeviceInfo.SerialNumber._value': token },
        { 'InternetGatewayDevice.DeviceInfo.SerialNumber._value': token.toUpperCase() }
      ];
      try {
        const res = await ax.get('/devices', {
          params: {
            query: JSON.stringify({ $or: orClauses }),
            limit: 1
          },
          timeout: 15000
        });
        if (Array.isArray(res.data) && res.data.length > 0) {
          return { server: srv, ax, device: res.data[0] };
        }
      } catch (_) {}
    }
  }
  return null;
}

async function fetchFullDeviceById(ax, deviceId) {
  const res = await ax.get('/devices', {
    params: { query: JSON.stringify({ _id: deviceId }), limit: 1 },
    timeout: 15000
  });
  return Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
}

async function pushFiberhomeAclTasks(ax, deviceId, device) {
  let currentDev = device;
  if (!currentDev?.InternetGatewayDevice?.X_FH_ACL) {
    await ax.post(`/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`, {
      name: 'refreshObject',
      objectName: 'InternetGatewayDevice.X_FH_ACL'
    }, { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    currentDev = (await fetchFullDeviceById(ax, deviceId).catch(() => null)) || currentDev;
  }

  const hasRule1 = Boolean(currentDev?.InternetGatewayDevice?.X_FH_ACL?.Rule?.['1']);
  if (!hasRule1) {
    await ax.post(`/devices/${encodeURIComponent(deviceId)}/tasks`, {
      name: 'addObject',
      objectName: 'InternetGatewayDevice.X_FH_ACL.Rule.'
    }, { timeout: 15000 });
  }

  await ax.post(`/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`, {
    name: 'setParameterValues',
    parameterValues: buildFiberhomeAclParameterValues()
  }, { timeout: 15000 });

  return { ok: true, ruleCreated: !hasRule1 };
}

/**
 * Push konfigurasi PPPoE (VLAN 100) + X_FH_ACL ke ONT FiberHome D2 pelanggan.
 * Pengaman non-overwrite:
 * - Jika force=false (mode auto-push), wajib menolak menimpa jika ONT sudah memiliki Username PPPoE aktif.
 * - Tidak pernah menyentuh WANConnectionDevice berisi TR069 (VLAN 20).
 */
async function provisionCustomerDevice(customerId, options = {}) {
  const force = Boolean(options.force);
  const triggerSource = String(options.triggerSource || (force ? 'manual' : 'auto'));
  const vlanId = parseInt(options.vlanId, 10) || DEFAULT_FIBERHOME_VLAN;

  const cust = db.prepare(`
    SELECT id, name, customer_code, ont_sn, pppoe_username, pppoe_password, connection_type, genieacs_auto_push
    FROM customers WHERE id = ?
  `).get(customerId);

  if (!cust) {
    return { ok: false, skipped: true, reason: 'customer_not_found', message: 'Pelanggan tidak ditemukan' };
  }
  if (String(cust.connection_type || 'pppoe').toLowerCase() !== 'pppoe') {
    return { ok: false, skipped: true, reason: 'not_pppoe', message: 'Tipe koneksi bukan PPPoE' };
  }
  const pppUser = String(cust.pppoe_username || '').trim();
  const pppPass = String(cust.pppoe_password || '').trim();
  const ontSn = String(cust.ont_sn || '').trim();

  if (!ontSn || !pppUser || !pppPass) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_credentials_or_sn',
      message: 'ONT SN, PPPoE Username, atau Password masih kosong'
    };
  }

  const found = await findGenieacsDeviceByIdentifiers([ontSn, cust.customer_code]);
  if (!found) {
    return {
      ok: false,
      deferred: true,
      reason: 'device_not_found_in_acs',
      message: `Modem SN ${ontSn} belum terdaftar/online di GenieACS`
    };
  }

  const { ax } = found;
  let dev = found.device;
  const devId = dev._id;

  let wanInfo = inspectFiberhomeWanSlots(dev);
  if (wanInfo.totalWcdCount === 0) {
    await ax.post(`/devices/${encodeURIComponent(devId)}/tasks?connection_request`, {
      name: 'refreshObject',
      objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice'
    }, { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));
    dev = (await fetchFullDeviceById(ax, devId).catch(() => null)) || dev;
    wanInfo = inspectFiberhomeWanSlots(dev);
  }

  if (wanInfo.totalWcdCount === 0 && !force) {
    return {
      ok: false,
      deferred: true,
      reason: 'wan_tree_not_ready',
      message: 'Tree WANConnectionDevice di GenieACS belum terbaca lengkap (akan dicoba ulang)'
    };
  }

  // PENGAMAN UTAMA: Cegah menimpa konfigurasi ONT yang sudah terisi PPPoE aktif
  const activeExisting = wanInfo.pppSlots.find(s => s.existingUsername.length > 0);
  if (activeExisting && !force) {
    const note = `Auto-push dilewati: ONT ${devId} sudah terisi PPPoE "${activeExisting.existingUsername}" di WCD.${activeExisting.wcdIndex}`;
    db.prepare(`
      UPDATE customers
      SET genieacs_auto_push = 0, genieacs_last_push_note = ?
      WHERE id = ?
    `).run(note, cust.id);
    logger.info(`[GenieACS Auto-Push] ${note}`);
    return {
      ok: true,
      skipped: true,
      reason: 'existing_pppoe_present',
      existingUsername: activeExisting.existingUsername,
      wcdIndex: activeExisting.wcdIndex,
      message: note
    };
  }

  // Tentukan target slot WAN PPPoE tanpa pernah menyentuh TR069 (VLAN 20)
  let targetSlot = wanInfo.pppSlots.find(s => s.existingUsername === '' && Number(s.vlan) === vlanId)
    || wanInfo.pppSlots.find(s => s.existingUsername === '')
    || wanInfo.pppSlots[0]
    || null;

  let needsAddObject = false;
  if (!targetSlot) {
    needsAddObject = true;
    const nextIdx = Math.max(2, wanInfo.nextAvailableWcdIndex);
    targetSlot = {
      wcdIndex: nextIdx,
      pppIndex: 1,
      existingUsername: '',
      lanInterface: ''
    };
  }

  // Pastikan target index tidak pernah sama dengan WCD TR069
  if (wanInfo.tr069Indices.includes(targetSlot.wcdIndex)) {
    throw new Error(`Safety abort: WCD.${targetSlot.wcdIndex} adalah interface TR-069 dan dilindungi.`);
  }

  if (needsAddObject) {
    await ax.post(`/devices/${encodeURIComponent(devId)}/tasks`, {
      name: 'addObject',
      objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.'
    }, { timeout: 15000 });
    await ax.post(`/devices/${encodeURIComponent(devId)}/tasks`, {
      name: 'addObject',
      objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${targetSlot.wcdIndex}.WANPPPConnection.`
    }, { timeout: 15000 });
  }

  const basePath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${targetSlot.wcdIndex}.WANPPPConnection.${targetSlot.pppIndex}`;
  const pppParamValues = [
    [`${basePath}.Enable`, true, 'xsd:boolean'],
    [`${basePath}.ConnectionType`, 'PPPoE_Routed', 'xsd:string'],
    [`${basePath}.VLANEnable`, true, 'xsd:boolean'],
    [`${basePath}.VLANID`, vlanId, 'xsd:unsignedInt'],
    [`${basePath}.NATEnabled`, true, 'xsd:boolean'],
    [`${basePath}.ConnectionTrigger`, 'AlwaysOn', 'xsd:string'],
    [`${basePath}.X_FH_ServiceList`, 'INTERNET', 'xsd:string'],
    [`${basePath}.Name`, `${targetSlot.wcdIndex}_INTERNET_R_VID_${vlanId}`, 'xsd:string'],
    [`${basePath}.Username`, pppUser, 'xsd:string'],
    [`${basePath}.Password`, pppPass, 'xsd:string']
  ];
  if (!targetSlot.lanInterface) {
    pppParamValues.push([`${basePath}.X_FH_LanInterface`, DEFAULT_FIBERHOME_LAN_BIND, 'xsd:string']);
  }

  await ax.post(`/devices/${encodeURIComponent(devId)}/tasks`, {
    name: 'setParameterValues',
    parameterValues: pppParamValues
  }, { timeout: 15000 });

  // Push ACL FiberHome HG6145D2 (identik brg1101) bila belum sesuai
  let aclPushed = false;
  if (force || !isFiberhomeAclAlreadyMatching(dev)) {
    await pushFiberhomeAclTasks(ax, devId, dev);
    aclPushed = true;
  }

  await ax.post(`/devices/${encodeURIComponent(devId)}/tasks?connection_request`, {
    name: 'refreshObject',
    objectName: basePath
  }, { timeout: 15000 }).catch(() => {});

  const successNote = `[${triggerSource}] Sukses push PPPoE (WCD.${targetSlot.wcdIndex}, VLAN ${vlanId}${needsAddObject ? ', baru' : ''})${aclPushed ? ' + ACL' : ''} ke ${devId}`;
  db.prepare(`
    UPDATE customers
    SET genieacs_auto_push = 0,
        genieacs_last_pushed_at = NOW_LOCAL(),
        genieacs_last_push_note = ?
    WHERE id = ?
  `).run(successNote, cust.id);

  logger.info(`[GenieACS Auto-Push] ${successNote}`);

  return {
    ok: true,
    skipped: false,
    deviceId: devId,
    wcdIndex: targetSlot.wcdIndex,
    pppIndex: targetSlot.pppIndex,
    createdNewWan: needsAddObject,
    aclPushed,
    message: successNote
  };
}

/**
 * Proses antrean pelanggan baru yang bertanda genieacs_auto_push = 1
 */
async function processPendingAutoPushQueue() {
  const pendingCustomers = db.prepare(`
    SELECT id, name, ont_sn, pppoe_username
    FROM customers
    WHERE genieacs_auto_push = 1
      AND LOWER(COALESCE(connection_type, 'pppoe')) = 'pppoe'
      AND COALESCE(TRIM(ont_sn), '') != ''
      AND COALESCE(TRIM(pppoe_username), '') != ''
      AND COALESCE(TRIM(pppoe_password), '') != ''
    ORDER BY id ASC
    LIMIT 20
  `).all();

  if (pendingCustomers.length === 0) {
    return { ok: true, checked: 0, pushed: 0, skipped: 0, deferred: 0 };
  }

  let pushed = 0;
  let skipped = 0;
  let deferred = 0;

  for (const c of pendingCustomers) {
    try {
      const res = await provisionCustomerDevice(c.id, { force: false, triggerSource: 'cron' });
      if (res.skipped) skipped++;
      else if (res.deferred) deferred++;
      else if (res.ok) pushed++;
    } catch (err) {
      deferred++;
      logger.warn(`[GenieACS Auto-Push] Gagal sementara untuk ${c.name} (${c.ont_sn}): ${err.message}`);
    }
  }

  return { ok: true, checked: pendingCustomers.length, pushed, skipped, deferred };
}

module.exports = {
  DEFAULT_FIBERHOME_VLAN,
  FIBERHOME_APPLICATION_LIST,
  buildFiberhomeAclParameterValues,
  inspectFiberhomeWanSlots,
  isFiberhomeAclAlreadyMatching,
  pushFiberhomeAclTasks,
  provisionCustomerDevice,
  processPendingAutoPushQueue
};
