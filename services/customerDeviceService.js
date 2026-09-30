/**
 * Logika GenieACS yang dipakai portal web dan bot WhatsApp.
 * Updated to support multi-server GenieACS setup.
 */
const axios = require('axios');
const db = require('../config/database');
const { getSettingsWithCache } = require('../config/settingsManager');
const auditTrail = require('./auditTrailService');
const { logger } = require('../config/logger');
const genieacsApi = require('../config/genieacs');
const mikrotikService = require('./mikrotikService');

// Helper: Search device across all servers (always get full data)
async function searchDeviceAcrossServers(query, fullData = true) {
  try {
    const servers = genieacsApi.getAllACSServers();
    
    for (const server of servers) {
      try {
        const instance = genieacsApi.createAxiosInstance(server);
        const params = {
          query: JSON.stringify(query)
        };
        
        // Only add projection if explicitly requesting minimal data
        if (!fullData) {
          params.projection = '_id,_tags';
        }

        let response;
        try {
          response = await instance.get('/devices', {
            params,
            timeout: 2000
          });
        } catch (e) {
          response = await instance.get('/api/devices', {
            params,
            timeout: 2000
          });
        }
        
        if (response.data && response.data.length > 0) {
          const device = response.data[0];
          device._acs_server_id = server.id;
          device._acs_server_name = server.name;
          logger.debug(`[CustomerDevice] Device found on ${server.name}`);
          return device;
        }
      } catch (error) {
        logger.debug(`[CustomerDevice] Device not found on ${server.name}: ${error.message}`);
      }
    }
    
    return null;
  } catch (error) {
    logger.error(`[CustomerDevice] Error searching device: ${error.message}`);
    return null;
  }
}

async function findDeviceByTag(tag) {
  try {
    const cleanTag = String(tag || '').trim();
    if (!cleanTag) return null;
    const query = {
      $or: [
        { _id: cleanTag },
        { _tags: cleanTag },
        { '_deviceId._SerialNumber': cleanTag },
        { 'DeviceID.SerialNumber': cleanTag },
        { 'InternetGatewayDevice.DeviceInfo.SerialNumber': cleanTag },
        { 'Device.DeviceInfo.SerialNumber': cleanTag },
        { 'VirtualParameters.PPPoEUser': cleanTag },
        { 'VirtualParameters.pppoeUsername': cleanTag },
        { 'VirtualParameters.customer_name': cleanTag }
      ]
    };
    if (cleanTag.length >= 5) {
      query.$or.push({ '_deviceId._SerialNumber': { $regex: cleanTag, $options: 'i' } });
      query.$or.push({ '_id': { $regex: cleanTag, $options: 'i' } });
    }
    // Get full data by default
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error finding device by tag: ${e.message}`);
    return null;
  }
}

async function findDeviceByPppoe(pppoeUser) {
  try {
    const user = String(pppoeUser || '').trim();
    if (!user) return null;
    const keys = [
      'VirtualParameters.PPPoEUser',
      'VirtualParameters.pppoeUsername',
      'VirtualParameters.pppUsername',
      'VirtualParameters.pppoe_user',
      ...PPPOE_USER_KEYS
    ];
    const query = {
      $or: [
        ...keys.map(k => ({ [k]: user })),
        { 'VirtualParameters.PPPoEUser': { $regex: user, $options: 'i' } }
      ]
    };
    // Get full data by default
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error finding device by PPPoE: ${e.message}`);
    return null;
  }
}

async function fetchFullDevice(tag) {
  try {
    const query = { $or: [{ _id: tag }, { _tags: tag }] };
    // Always get full data
    return await searchDeviceAcrossServers(query, true);
  } catch (e) {
    logger.error(`[CustomerDevice] Error fetching full device: ${e.message}`);
    return null;
  }
}

async function resolveDeviceToken(input) {
  const token = String(input ?? '').replace(/[\r\n\t]+/g, '').trim();
  if (!token) return null;

  // 1. Direct fast lookup in Built-in ACS if enabled
  if (typeof genieacsApi.isBuiltinAcsEnabled === 'function' && genieacsApi.isBuiltinAcsEnabled()) {
    try {
      const db = require('../config/database');
      const row = db.prepare(`
        SELECT * FROM acs_devices 
        WHERE id = ? OR serial_number = ? OR id LIKE ? OR serial_number LIKE ?
        LIMIT 1
      `).get(token, token, `%${token}%`, `%${token}%`);
      if (row && typeof genieacsApi.builtinRowToDevice === 'function') {
        const dev = genieacsApi.builtinRowToDevice(row);
        if (dev && dev._id) {
          dev._acs_server_id = 'builtin';
          dev._acs_server_name = 'Built-in ACS';
          return dev;
        }
      }
    } catch (_) {}
  }

  const direct = await findDeviceByTag(token);
  if (direct && direct._id) return direct;

  const byPppoe = await findDeviceByPppoe(token);
  if (byPppoe && byPppoe._id) return byPppoe;

  const found = await findDeviceWithTagVariants(token);
  if (found && found.device && found.device._id) return found.device;

  return null;
}

const parameterPaths = {
  serialNumber: [
    'DeviceID.SerialNumber',
    'InternetGatewayDevice.DeviceInfo.SerialNumber',
    'Device.DeviceInfo.SerialNumber'
  ],
  model: [
    'DeviceID.ProductClass',
    'InternetGatewayDevice.DeviceInfo.ModelName',
    'Device.DeviceInfo.ModelName',
    'ModelName'
  ],
  softwareVersion: [
    'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'Device.DeviceInfo.SoftwareVersion'
  ],
  ssid: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    'Device.WiFi.SSID.1.SSID',
    'Device.WiFi.SSID.2.SSID'
  ],
  ssid24: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    'Device.WiFi.SSID.1.SSID'
  ],
  ssid5: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
    'Device.WiFi.SSID.2.SSID'
  ],
  wifiPassword: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
    'Device.WiFi.AccessPoint.1.Security.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase'
  ],
  wifiPassword24: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
    'Device.WiFi.AccessPoint.1.Security.KeyPassphrase'
  ],
  wifiPassword5: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.KeyPassphrase',
    'Device.WiFi.AccessPoint.2.Security.KeyPassphrase'
  ],
  rxPower: [
    'VirtualParameters.RXPower',
    'VirtualParameters.redaman',
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
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower',
    'Device.Optical.Interface.1.OpticalSignalLevel',
    'Device.XPON.Interface.1.Stats.RXPower'
  ],
  pppoeIP: [
    'VirtualParameters.pppoeIP',
    'VirtualParameters.pppIP',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1.ExternalIPAddress',
    'Device.PPP.Interface.1.ExternalIPAddress',
    'Device.IP.Interface.1.IPv4Address.1.IPAddress'
  ],
  pppUsername: [
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.3.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.2.Username',
    'Device.PPP.Interface.1.Username',
    'Device.PPP.Interface.2.Username',
    'Device.PPP.Interface.3.Username'
  ],
  uptime: [
    'VirtualParameters.getdeviceuptime',
    'InternetGatewayDevice.DeviceInfo.UpTime',
    'Device.DeviceInfo.UpTime'
  ],
  userConnected: [
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDeviceNumberOfEntries',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDeviceNumberOfEntries',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Associations',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Associations',
    'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
    'Device.WiFi.AccessPoint.2.AssociatedDeviceNumberOfEntries'
  ]
};

// PPPoE IP search keys matching user's template
const PPPOE_IP_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress',
  'Device.PPP.Interface.1.ExternalIPAddress',
  'Device.IP.Interface.1.IPv4Address.1.IPAddress'
];

// PPPoE Username search keys matching user's template
const PPPOE_USER_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.2.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username',
  'Device.PPP.Interface.1.Username',
  'Device.PPP.Interface.2.Username',
  'Device.PPP.Interface.3.Username'
];

function getNestedValue(obj, path) {
  try {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (!current) return null;
      current = current[part];
    }
    if (current && typeof current === 'object' && '_value' in current) {
      return current._value;
    }
    if (current && typeof current === 'object' && current.hasOwnProperty('_value')) {
      return current._value;
    }
    return current;
  } catch (e) {
    return null;
  }
}

function getWildcardMatches(device, path) {
  const parts = path.split('.');
  const results = [];

  function recurse(current, index, currentPathParts) {
    if (current === undefined || current === null) return;
    
    if (index === parts.length) {
      let val = current;
      if (typeof current === 'object' && '_value' in current) {
        val = current._value;
      }
      results.push({
        path: currentPathParts.join('.'),
        value: val
      });
      return;
    }

    const part = parts[index];
    if (part === '*') {
      if (typeof current === 'object') {
        for (const key of Object.keys(current)) {
          if (!key.startsWith('_')) {
            recurse(current[key], index + 1, [...currentPathParts, key]);
          }
        }
      }
    } else {
      if (typeof current === 'object') {
        const targetLower = part.toLowerCase();
        for (const key of Object.keys(current)) {
          if (key.toLowerCase() === targetLower) {
            recurse(current[key], index + 1, [...currentPathParts, key]);
          }
        }
      }
    }
  }

  recurse(device, 0, []);
  return results;
}

function getDeviceParameterValue(device, keys, filterFn) {
  for (const key of keys) {
    const matches = getWildcardMatches(device, key);
    for (const match of matches) {
      if (filterFn) {
        if (filterFn(match.path, match.value, device)) {
          return match.value;
        }
      } else if (match.value !== undefined && match.value !== null && match.value !== '') {
        return match.value;
      }
    }
  }
  return '';
}

function extractPppoeIp(d) {
  const ip = getDeviceParameterValue(d, PPPOE_IP_KEYS, (matchedPath, value, device) => {
    if (!value || value === '0.0.0.0' || value === '-') return false;
    
    if (matchedPath.includes('WANPPPConnection.')) {
      const connectionTypePath = matchedPath.replace('ExternalIPAddress', 'ConnectionType');
      const connTypeMatches = getWildcardMatches(device, connectionTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'bridge') {
        return false;
      }
    }
    return true;
  });
  
  if (ip) return ip;
  if (d._ip && d._ip !== '-' && d._ip !== '0.0.0.0') return d._ip;
  return 'N/A';
}

function extractPppoeUser(d) {
  const user = getDeviceParameterValue(d, PPPOE_USER_KEYS, (matchedPath, value, device) => {
    if (!value || value === '-') return false;
    
    if (matchedPath.includes('WANPPPConnection.')) {
      const connectionTypePath = matchedPath.replace('Username', 'ConnectionType');
      const connTypeMatches = getWildcardMatches(device, connectionTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'PPPoE_Bridged') {
        return false;
      }
    }
    return true;
  });
  
  return user || 'N/A';
}

function formatUptime(seconds) {
  if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || 'N/A';
  if (typeof seconds === 'string' && (seconds.includes('d') || seconds.includes(':')) && isNaN(seconds)) {
    return seconds;
  }
  const totalSecs = parseInt(seconds, 10);
  if (isNaN(totalSecs)) return seconds || 'N/A';
  const days = Math.floor(totalSecs / 86400);
  const rem = totalSecs % 86400;
  let hrs = Math.floor(rem / 3600);
  if (hrs < 10) hrs = "0" + hrs;
  const rem2 = rem % 3600;
  let mins = Math.floor(rem2 / 60);
  if (mins < 10) mins = "0" + mins;
  let secs = rem2 % 60;
  if (secs < 10) secs = "0" + secs;
  return days + "d " + hrs + ":" + mins + ":" + secs;
}

function formatDeviceTimestamp(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID');
}

function formatRelativeTime(value) {
  if (!value) return '-';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '-';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'baru saja';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec} detik lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} menit lalu`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} jam lalu`;
  const day = Math.floor(hour / 24);
  return `${day} hari lalu`;
}

function collectRefreshObjects(device) {
  const objects = [];
  const isTr181 = !!device?.Device;

  if (isTr181) {
    // TR-181 Device
    objects.push('Device.Hosts.Host');
    objects.push('Device.WiFi.AccessPoint.1.AssociatedDevice');
    objects.push('Device.WiFi.AccessPoint.2.AssociatedDevice');
  } else {
    // TR-098 Device (InternetGatewayDevice - Fiberhome, ZTE, Huawei, etc.)
    // Always poll Hosts.Host (where Fiberhome, ZTE, Huawei keep LAN/WLAN hosts)
    objects.push('InternetGatewayDevice.LANDevice.1.Hosts.Host');
    objects.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice');
    // Fiberhome / multi-AP dual band 5GHz
    objects.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.AssociatedDevice');
    objects.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice');
  }

  return Array.from(new Set(objects));
}

function getBuiltinSyncState(deviceId) {
  const empty = {
    syncInProgress: false,
    syncPendingCount: 0,
    syncLastQueueAt: '',
    syncLastQueueLabel: '-',
    syncStatusLabel: 'Idle'
  };
  if (!deviceId) return empty;

  try {
    const pending = db.prepare(
      `SELECT COUNT(*) AS count, MAX(created_at) AS last_queue_at
       FROM acs_tasks
       WHERE device_id = ?
         AND name IN ('refreshObject', 'getParameterValues', 'getParameterNames')
         AND status IN ('pending', 'in_progress')`
    ).get(deviceId);

    const count = Number(pending?.count || 0);
    const lastQueueAt = String(pending?.last_queue_at || '');
    return {
      syncInProgress: count > 0,
      syncPendingCount: count,
      syncLastQueueAt: lastQueueAt,
      syncLastQueueLabel: formatDeviceTimestamp(lastQueueAt),
      syncStatusLabel: count > 0 ? `Sinkronisasi berjalan (${count})` : 'Idle'
    };
  } catch (e) {
    logger.debug(`[CustomerDevice] Failed reading ACS sync state for ${deviceId}: ${e.message}`);
    return empty;
  }
}

const PPPOE_UPTIME_KEYS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Uptime',
  'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Uptime',
  'Device.PPP.Interface.1.UpTime'
];

function extractPppoeUptime(d) {
  let uptimeVal = getDeviceParameterValue(d, PPPOE_UPTIME_KEYS, (matchedPath, value, device) => {
    if (value === undefined || value === null || value === '' || value === '-') return false;
    
    if (matchedPath.toLowerCase().includes('wanpppconnection')) {
      const connTypePath = matchedPath.substring(0, matchedPath.toLowerCase().lastIndexOf('.uptime')) + '.ConnectionType';
      const connTypeMatches = getWildcardMatches(device, connTypePath);
      if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'PPPoE_Bridged') {
        return false;
      }
    }
    return true;
  });

  if (!uptimeVal || uptimeVal === '-') {
    const UPTIME_PATHS = [
      'VirtualParameters.getdeviceuptime',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      'Device.DeviceInfo.UpTime'
    ];
    for (const path of UPTIME_PATHS) {
      const val = getNestedValue(d, path);
      if (val && val !== '-' && val !== '') {
        uptimeVal = val;
        break;
      }
    }
  }

  if (uptimeVal) {
    return formatUptime(uptimeVal);
  }
  return 'N/A';
}

function getParameterWithPaths(device, paths) {
  let values = [];
  for (const p of paths) {
    const parts = p.split('.');
    let value = device;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
        if (value && value._value !== undefined) value = value._value;
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined && value !== null && value !== '' && value !== 'N/A') {
      const isIpPath = p.toLowerCase().includes('ipaddress') || p.toLowerCase().includes('pppoeip') || p.toLowerCase().includes('pppip') || p.toLowerCase().includes('pppusername') || p.toLowerCase().includes('pppoeusername');
      if (isIpPath && String(value) === '0.0.0.0') {
        continue;
      }
      const isCountParam = p.includes('TotalAssociations') || 
                           p.includes('AssociatedDeviceNumberOfEntries') || 
                           p.includes('HostNumberOfEntries');
                           
      if (isCountParam) {
        // Ensure we push a number
        const val = (typeof value === 'object' && value._value !== undefined) ? value._value : value;
        values.push(parseInt(val) || 0);
      } else {
        // If it's still an object, try to get _value or stringify it
        if (typeof value === 'object') {
          if (value._value !== undefined) return String(value._value);
          return 'N/A'; // Don't return raw object
        }
        return String(value);
      }
    }
  }
  
  if (values.length > 0) {
    // If it's a count parameter, sum them up (for dual band)
    return values.reduce((a, b) => a + b, 0);
  }
  
  return 'N/A';
}

function expandTagCandidates(input) {
  const t = String(input || '').trim();
  if (!t) return [];
  if (/^\d+$/.test(t)) {
    const d = t.replace(/\D/g, '');
    const set = new Set([d]);
    if (d.startsWith('62') && d.length > 2) set.add('0' + d.slice(2));
    if (d.startsWith('0')) set.add('62' + d.slice(1));
    return [...set];
  }
  return [t];
}

/** Coba beberapa varian tag (62/0 untuk nomor) sampai device ketemu */
async function findDeviceWithTagVariants(input) {
  for (const c of expandTagCandidates(input)) {
    const dev = await findDeviceByTag(c);
    if (dev) return { device: dev, canonicalTag: c };
  }
  return null;
}

/** Nomor dari JID WhatsApp @s.whatsapp.net */
function phoneFromPnJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const [user, host] = jid.split('@');
  if (!user || host !== 's.whatsapp.net') return null;
  return user.replace(/\D/g, '') || null;
}

function mapDeviceData(device, tag, isPppoeActive = false) {
  if (!device) return null;

  const ssid = getParameterWithPaths(device, parameterPaths.ssid);
  const ssidDisplay = ssid === 'N/A' ? '-' : ssid;

  const lastInformRaw =
    device?._lastInform ||
    device?.Events?.Inform ||
    device?.InternetGatewayDevice?.DeviceInfo?.['1']?.LastInform?._value ||
    '';
  const lastInform = formatDeviceTimestamp(lastInformRaw);
  const lastSyncRaw = device?._updatedAt || lastInformRaw || '';
  const lastSync = formatDeviceTimestamp(lastSyncRaw);
  const syncState = getBuiltinSyncState(device?._id);

  let status = 'Unknown';
  if (device?._lastInform) {
    const diffMs = Date.now() - new Date(device._lastInform).getTime();
    status = diffMs < 15 * 60 * 1000 ? 'Online' : 'Offline';
  } else if (device?.Events?.Inform) {
    const diffMs = Date.now() - new Date(device.Events.Inform).getTime();
    status = diffMs < 15 * 60 * 1000 ? 'Online' : 'Offline';
  }

  if (status !== 'Online' && isPppoeActive) {
    status = 'Online';
  }

  let connectedUsers = [];
  try {
    const activeWifiMacs = new Set();
    const activeWifiDetails = new Map();

    // 1. Gather all physically connected Wi-Fi devices from WLAN AssociatedDevice tables
    const wlanConfigs = [
      device?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration,
      device?.InternetGatewayDevice?.LANDevice?.['2']?.WLANConfiguration
    ];
    for (const wc of wlanConfigs) {
      if (wc && typeof wc === 'object') {
        for (const bKey of Object.keys(wc)) {
          if (bKey.startsWith('_')) continue;
          const band = wc[bKey];
          if (!band || typeof band !== 'object') continue;
          const ssidName = (typeof band.SSID === 'object' ? band.SSID?._value : band.SSID) || (bKey === '5' ? '5GHz' : '2.4GHz');
          const assoc = band.AssociatedDevice;
          if (assoc && typeof assoc === 'object') {
            const entries = Array.isArray(assoc) ? assoc : Object.values(assoc);
            for (const item of entries) {
              if (!item || typeof item !== 'object') continue;
              const mac = String(
                (typeof item.AssociatedDeviceMACAddress === 'object' ? item.AssociatedDeviceMACAddress?._value : item.AssociatedDeviceMACAddress) ||
                (typeof item.MACAddress === 'object' ? item.MACAddress?._value : item.MACAddress) ||
                ''
              ).trim().toLowerCase();
              if (mac && mac.length >= 10 && mac !== '-') {
                activeWifiMacs.add(mac);
                const ip = (typeof item.IPAddress === 'object' ? item.IPAddress?._value : item.IPAddress) ||
                           (typeof item.IP === 'object' ? item.IP?._value : item.IP) || '-';
                const hostname = (typeof item.HostName === 'object' ? item.HostName?._value : item.HostName) ||
                                 (typeof item.DeviceName === 'object' ? item.DeviceName?._value : item.DeviceName) || '-';
                activeWifiDetails.set(mac, { ssidName, ip, hostname });
              }
            }
          }
        }
      }
    }

    // Check TR-181 AccessPoint AssociatedDevice
    const tr181APs = device?.Device?.WiFi?.AccessPoint;
    if (tr181APs && typeof tr181APs === 'object') {
      for (const k of Object.keys(tr181APs)) {
        if (k.startsWith('_')) continue;
        const ap = tr181APs[k];
        if (!ap || typeof ap !== 'object') continue;
        const assoc = ap.AssociatedDevice;
        if (assoc && typeof assoc === 'object') {
          const entries = Array.isArray(assoc) ? assoc : Object.values(assoc);
          for (const item of entries) {
            if (!item || typeof item !== 'object') continue;
            const mac = String(
              (typeof item.MACAddress === 'object' ? item.MACAddress?._value : item.MACAddress) ||
              (typeof item.AssociatedDeviceMACAddress === 'object' ? item.AssociatedDeviceMACAddress?._value : item.AssociatedDeviceMACAddress) ||
              ''
            ).trim().toLowerCase();
            if (mac && mac.length >= 10 && mac !== '-') {
              activeWifiMacs.add(mac);
              activeWifiDetails.set(mac, {
                ssidName: k === '2' ? '5GHz' : '2.4GHz',
                ip: '-',
                hostname: '-'
              });
            }
          }
        }
      }
    }

    // 2. Parse Hosts.Host list (LAN & Wi-Fi)
    const hosts = device?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host || device?.Device?.Hosts?.Host;
    if (hosts && typeof hosts === 'object') {
      const entries = Array.isArray(hosts) ? hosts : Object.values(hosts);
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const mac = String(
          (typeof entry.MACAddress === 'object' ? entry.MACAddress?._value : entry.MACAddress) || '-'
        ).trim();
        if (!mac || mac === '-' || mac.length < 10) continue;

        const macLower = mac.toLowerCase();
        const ip = (typeof entry.IPAddress === 'object' ? entry.IPAddress?._value : entry.IPAddress) || '-';
        const hostname = (typeof entry.HostName === 'object' ? entry.HostName?._value : entry.HostName) || '-';
        const ifaceRaw = String(
          (typeof entry.InterfaceType === 'object' ? entry.InterfaceType?._value : entry.InterfaceType) ||
          (typeof entry.Layer2Interface === 'object' ? entry.Layer2Interface?._value : entry.Layer2Interface) ||
          entry.Interface ||
          '-'
        );

        const isWiFi = ifaceRaw.toLowerCase().includes('802.11') ||
                       ifaceRaw.toLowerCase().includes('wifi') ||
                       ifaceRaw.toLowerCase().includes('wlan') ||
                       activeWifiMacs.has(macLower);

        let isReallyOnline = false;
        let ifaceLabel = 'Koneksi Kabel LAN';

        const activeVal = typeof entry.Active === 'object' ? entry.Active?._value : entry.Active;
        const isEntryActive = activeVal === true || activeVal === 'true' || activeVal === 1 || activeVal === '1';

        if (isWiFi) {
          if (activeWifiMacs.has(macLower)) {
            isReallyOnline = true;
          } else if (activeWifiMacs.size > 0) {
            // AssociatedDevice table exists and is populated, but this MAC isn't in it -> offline
            isReallyOnline = false;
          } else {
            // AssociatedDevice table not supplied by ONT (e.g. Fiberhome) -> trust Host.Active
            isReallyOnline = isEntryActive;
          }
          const wifiDetail = activeWifiDetails.get(macLower);
          const is5G = ifaceRaw.includes('5') || (wifiDetail && wifiDetail.ssidName && wifiDetail.ssidName.includes('5G'));
          ifaceLabel = wifiDetail ? `WiFi ${wifiDetail.ssidName}` : (is5G ? 'WiFi 5GHz' : 'WiFi 2.4GHz');
        } else {
          // Wired LAN Ethernet clients
          isReallyOnline = isEntryActive;
          ifaceLabel = 'Koneksi Kabel LAN';
        }

        connectedUsers.push({
          hostname: hostname || '-',
          ip: ip || '-',
          mac: mac || '-',
          iface: ifaceLabel,
          status: isReallyOnline ? 'Online' : 'Offline'
        });
      }
    }

    // 3. Include any active Wi-Fi clients that might not yet be in Hosts.Host
    for (const [macLower, info] of activeWifiDetails.entries()) {
      const exists = connectedUsers.some(u => String(u.mac || '').toLowerCase() === macLower);
      if (!exists) {
        connectedUsers.push({
          hostname: info.hostname && info.hostname !== '-' ? info.hostname : 'Perangkat Wi-Fi',
          ip: info.ip || '-',
          mac: macLower,
          iface: `WiFi ${info.ssidName || ''}`.trim(),
          status: 'Online'
        });
      }
    }

    // Deduplicate by MAC address
    const userMap = new Map();
    for (const u of connectedUsers) {
      const macKey = String(u.mac || '').toLowerCase();
      if (!macKey || macKey === '-') continue;
      if (!userMap.has(macKey)) {
        userMap.set(macKey, u);
      } else {
        const existing = userMap.get(macKey);
        if (u.status === 'Online' && existing.status !== 'Online') {
          userMap.set(macKey, u);
        }
      }
    }
    connectedUsers = Array.from(userMap.values());
  } catch (e) {
    logger.warn(`[CustomerDevice] Error parsing connected users: ${e.message}`);
  }

  let rxPower = getParameterWithPaths(device, parameterPaths.rxPower);
  if (rxPower !== 'N/A' && rxPower !== '-' && rxPower !== '') {
    const num = parseFloat(rxPower);
    if (!isNaN(num) && num > 0) {
      const dbVal = 30 + (Math.log10(num * Math.pow(10, -7)) * 10);
      rxPower = (Math.ceil(dbVal * 100) / 100).toFixed(2);
    }
  }
  const pppoeIP = extractPppoeIp(device);
  const pppoeUsername = extractPppoeUser(device);
  const uptimeRaw = getParameterWithPaths(device, parameterPaths.uptime);

  // Total active connected associations (WLAN + active LAN)
  let onlineUsers = connectedUsers.filter(u => u.status === 'Online');
  let totalAssociations = onlineUsers.length;

  // Fallback: check reported TotalAssociations if onlineUsers count is 0
  if (totalAssociations === 0) {
    const rawAssoc = getParameterWithPaths(device, [
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
      'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
      'Device.WiFi.AccessPoint.2.AssociatedDeviceNumberOfEntries'
    ]);
    const numAssoc = parseInt(rawAssoc, 10);
    if (!isNaN(numAssoc) && numAssoc > 0) {
      totalAssociations = numAssoc;
      // If modem explicitly reports clients > 0 but Host.Active was omitted, mark top hosts as Online
      let marked = 0;
      for (const u of connectedUsers) {
        if (marked < totalAssociations) {
          u.status = 'Online';
          marked++;
        }
      }
    }
  }

  function formatUptime(seconds) {
    if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || 'N/A';
    if (typeof seconds === 'string' && (seconds.includes('d') || seconds.includes(':')) && isNaN(seconds)) {
      return seconds;
    }
    const totalSecs = parseInt(seconds, 10);
    if (isNaN(totalSecs)) return seconds || 'N/A';
    const days = Math.floor(totalSecs / 86400);
    const rem = totalSecs % 86400;
    
    let hrs = Math.floor(rem / 3600);
    if (hrs < 10) hrs = "0" + hrs;
    
    const rem2 = rem % 3600;
    let mins = Math.floor(rem2 / 60);
    if (mins < 10) mins = "0" + mins;
    
    let secs = rem2 % 60;
    if (secs < 10) secs = "0" + secs;
    
    return days + "d " + hrs + ":" + mins + ":" + secs;
  }
  const uptime = formatUptime(uptimeRaw);
  const pppoeUptime = extractPppoeUptime(device);

  const serialNumber = getParameterWithPaths(device, parameterPaths.serialNumber);
  const productClass = getParameterWithPaths(device, parameterPaths.model);
  const softwareVersion = getParameterWithPaths(device, parameterPaths.softwareVersion);
  const wifiPassword = getParameterWithPaths(device, parameterPaths.wifiPassword);
  const model = productClass;

  const ssid24Val = getParameterWithPaths(device, parameterPaths.ssid24);
  const ssid5Val = getParameterWithPaths(device, parameterPaths.ssid5);
  const wifiPassword24Val = getParameterWithPaths(device, parameterPaths.wifiPassword24);
  const wifiPassword5Val = getParameterWithPaths(device, parameterPaths.wifiPassword5);

  const ssid24 = (ssid24Val && ssid24Val !== 'N/A' && ssid24Val !== '-') ? ssid24Val : (ssidDisplay !== '-' ? ssidDisplay : '-');
  const ssid5 = (ssid5Val && ssid5Val !== 'N/A' && ssid5Val !== '-') ? ssid5Val : (ssid24 !== '-' ? `${ssid24}-5G` : '');
  const wifiPassword24 = (wifiPassword24Val && wifiPassword24Val !== 'N/A') ? wifiPassword24Val : (wifiPassword === 'N/A' ? '' : wifiPassword);
  const wifiPassword5 = (wifiPassword5Val && wifiPassword5Val !== 'N/A') ? wifiPassword5Val : wifiPassword24;

  let lokasi = device?._tags || '-';
  if (Array.isArray(lokasi)) lokasi = lokasi.join(', ');

  return {
    phone: tag,
    ssid: ssidDisplay,
    ssid24: ssid24,
    ssid5: ssid5,
    wifiPassword: wifiPassword === 'N/A' ? '' : wifiPassword,
    wifiPassword24: wifiPassword24,
    wifiPassword5: wifiPassword5,
    isDualBand: true,
    status,
    lastInform,
    lastInformRaw: lastInformRaw || '',
    lastInformAgo: formatRelativeTime(lastInformRaw),
    lastSync,
    lastSyncRaw: lastSyncRaw || '',
    lastSyncAgo: formatRelativeTime(lastSyncRaw),
    syncInProgress: !!syncState.syncInProgress,
    syncPendingCount: Number(syncState.syncPendingCount || 0),
    syncLastQueueAt: syncState.syncLastQueueAt || '',
    syncLastQueueLabel: syncState.syncLastQueueLabel || '-',
    syncStatusLabel: syncState.syncStatusLabel || 'Idle',
    connectedUsers,
    rxPower: rxPower === 'N/A' ? '-' : rxPower,
    pppoeIP: pppoeIP === 'N/A' ? '-' : pppoeIP,
    pppoeUsername: pppoeUsername === 'N/A' ? '-' : pppoeUsername,
    pppoeUptime: pppoeUptime === 'N/A' ? '-' : pppoeUptime,
    serialNumber: serialNumber === 'N/A' ? '-' : serialNumber,
    productClass: productClass === 'N/A' ? '-' : productClass,
    lokasi,
    softwareVersion: softwareVersion === 'N/A' ? '-' : softwareVersion,
    model: model === 'N/A' ? '-' : model,
    uptime: uptime === 'N/A' ? '-' : uptime,
    totalAssociations
  };
}

async function getCustomerDeviceData(tag) {
  const base = await resolveDeviceToken(tag);
  if (!base || !base._id) return null;
  const device = await fetchFullDevice(base._id);
  
  let isPppoeActive = false;
  try {
    const pppoeUser = extractPppoeUser(device);
    if (pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-') {
      const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());
      if (activeSessionsMap.has(pppoeUser.toLowerCase())) {
        isPppoeActive = true;
      }
    }
  } catch (e) {}

  return mapDeviceData(device, tag, isPppoeActive);
}

function fallbackCustomer(tag) {
  return {
    phone: tag,
    ssid: '-',
    ssid24: '-',
    ssid5: '',
    wifiPassword: '',
    wifiPassword24: '',
    wifiPassword5: '',
    isDualBand: true,
    status: 'Tidak ditemukan',
    lastInform: '-',
    lastInformAgo: '-',
    lastSync: '-',
    lastSyncAgo: '-',
    syncInProgress: false,
    syncPendingCount: 0,
    syncLastQueueLabel: '-',
    syncStatusLabel: 'Idle',
    connectedUsers: [],
    rxPower: '-',
    pppoeIP: '-',
    pppoeUsername: '-',
    pppoeUptime: '-',
    serialNumber: '-',
    productClass: '-',
    lokasi: '-',
    softwareVersion: '-',
    model: '-',
    uptime: '-',
    totalAssociations: '-'
  };
}

async function updateSSID(tag, newSSID, actor = null, band = 'all') {
  try {
    const device = await resolveDeviceToken(tag);
    if (!device) return false;
    const deviceId = encodeURIComponent(device._id);
    
    // Gunakan server yang sesuai
    const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
    if (!server) return false;
    
    const instance = genieacsApi.createAxiosInstance(server);
    // Tambahkan ?connection_request agar GenieACS langsung mengirimkan Connection Request ke modem
    const tasksUrl = `/devices/${deviceId}/tasks?connection_request`;

    const targetBand = String(band || 'all').toLowerCase();
    const shouldUpdate24 = targetBand === 'all' || targetBand === '2.4' || targetBand === '2.4ghz';
    const shouldUpdate5 = targetBand === 'all' || targetBand === '5' || targetBand === '5ghz';

    // Check supported paths in DB
    const db = require('../config/database');
    const row = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(device._id);
    const flatParams = row && row.params ? JSON.parse(row.params) : null;
    const isTr181 = flatParams 
      ? Object.keys(flatParams).some(k => k.startsWith('Device.'))
      : (device._deviceId?._ProductClass?.includes('TR181') || false);

    let ok = false;

    // ── 2.4 GHz SSID ──
    if (shouldUpdate24) {
      const p24 = isTr181 
        ? 'Device.WiFi.SSID.1.SSID'
        : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID';
      try {
        await instance.post(tasksUrl, {
          name: 'setParameterValues',
          parameterValues: [
            [p24, newSSID, 'xsd:string'],
            [isTr181 ? 'Device.WiFi.SSID.1.Enable' : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable', 'true', 'xsd:boolean']
          ]
        }, { timeout: 10000 });
        ok = true;
      } catch (e) {
        logger.error(`[updateSSID 2.4G] Error: ${e.message}`);
      }
    }

    // ── 5 GHz SSID ──
    if (shouldUpdate5) {
      const ssid5Name = (targetBand === '5' || targetBand === '5ghz') 
        ? newSSID 
        : (newSSID.toLowerCase().endsWith('-5g') ? newSSID : `${newSSID}-5G`);

      if (isTr181) {
        try {
          await instance.post(tasksUrl, {
            name: 'setParameterValues',
            parameterValues: [
              ['Device.WiFi.SSID.2.SSID', ssid5Name, 'xsd:string'],
              ['Device.WiFi.SSID.2.Enable', 'true', 'xsd:boolean']
            ]
          }, { timeout: 10000 });
          ok = true;
        } catch (e) {
          logger.error(`[updateSSID 5G TR-181] Error: ${e.message}`);
        }
      } else {
        // TR-098 5 GHz (Fiberhome HG6145D2/HG6845F3, ZTE F670L, Huawei, etc.)
        let target5Path = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID';
        if (flatParams && flatParams['InternetGatewayDevice.LANDevice.2.WLANConfiguration.1.SSID'] !== undefined) {
          target5Path = 'InternetGatewayDevice.LANDevice.2.WLANConfiguration.1.SSID';
        } else if (device && device.InternetGatewayDevice?.LANDevice?.['2']?.WLANConfiguration) {
          target5Path = 'InternetGatewayDevice.LANDevice.2.WLANConfiguration.1.SSID';
        }

        const enablePath = target5Path.replace(/\.SSID$/, '.Enable');

        try {
          const pValues = [
            [target5Path, ssid5Name, 'xsd:string'],
            [enablePath, 'true', 'xsd:boolean']
          ];
          // Matikan Guest/Secondary SSID (index 2) agar tidak terjadi SSID kembar di rumah pelanggan
          if (target5Path.includes('WLANConfiguration.5')) {
            pValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Enable', 'false', 'xsd:boolean']);
          }

          await instance.post(tasksUrl, {
            name: 'setParameterValues',
            parameterValues: pValues
          }, { timeout: 10000 });
          ok = true;
          logger.info(`[updateSSID 5G] Enqueued SSID '${ssid5Name}' on ${target5Path}`);
        } catch (e) {
          try {
            await instance.post(tasksUrl, {
              name: 'setParameterValues',
              parameterValues: [
                [target5Path, ssid5Name, 'xsd:string'],
                [enablePath, 'true', 'xsd:boolean']
              ]
            }, { timeout: 10000 });
            ok = true;
          } catch (e2) {
            logger.error(`[updateSSID 5G] Error on ${target5Path}: ${e2.message}`);
          }
        }
      }
    }

    // Wake up modem instantly via CWMP Connection Request
    if (ok) {
      try {
        const acsServer = require('./acsServerService');
        if (acsServer && typeof acsServer.triggerConnectionRequest === 'function') {
          acsServer.triggerConnectionRequest(device._id).catch(() => {});
        }
      } catch (_) {}
    }

    // Catat audit trail jika berhasil
    if (ok && actor) {
      auditTrail.logAuditTrail({
        action: 'UPDATE_SSID',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          oldSSID: device._id || 'unknown',
          newSSID: newSSID,
          band: targetBand
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return ok;
  } catch (e) {
    logger.error(`[updateSSID] Exception: ${e.message}`);
    return false;
  }
}

async function updatePassword(tag, newPassword, actor = null, band = 'all') {
  try {
    const pwRaw = String(newPassword ?? '');
    const pw = pwRaw.replace(/[\r\n\t]+/g, '').trim();
    if (pw.length < 8) {
      logger.warn(`[updatePassword] Password too short for tag ${tag}`);
      return false;
    }
    const device = await resolveDeviceToken(tag);
    if (!device) {
      logger.warn(`[updatePassword] Device not found for tag ${tag}`);
      return false;
    }
    const deviceId = encodeURIComponent(device._id);
    
    // Gunakan server yang sesuai
    const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
    if (!server) return false;
    
    const instance = genieacsApi.createAxiosInstance(server);
    // Tambahkan ?connection_request agar task langsung dieksekusi di modem sekarang juga
    const tasksUrl = `/devices/${deviceId}/tasks?connection_request`;

    logger.info(`[updatePassword] Setting password for device ${deviceId}, tag ${tag}, band ${band}`);

    const targetBand = String(band || 'all').toLowerCase();
    const shouldUpdate24 = targetBand === 'all' || targetBand === '2.4' || targetBand === '2.4ghz';
    const shouldUpdate5 = targetBand === 'all' || targetBand === '5' || targetBand === '5ghz';
    
    // Check supported paths in DB
    const db = require('../config/database');
    const row = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(device._id);
    const flatParams = row && row.params ? JSON.parse(row.params) : null;
    const isTr181 = flatParams 
      ? Object.keys(flatParams).some(k => k.startsWith('Device.'))
      : (device._deviceId?._ProductClass?.includes('TR181') || false);
    
    let ok = false;

    // ── 2.4 GHz Password ──
    if (shouldUpdate24) {
      if (isTr181) {
        try {
          await instance.post(tasksUrl, {
            name: 'setParameterValues',
            parameterValues: [['Device.WiFi.AccessPoint.1.Security.KeyPassphrase', pw, 'xsd:string']]
          }, { timeout: 10000 });
          ok = true;
        } catch (_) {}
      } else {
        const psk24 = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey';
        const kp24 = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase';
        try {
          await instance.post(tasksUrl, {
            name: 'setParameterValues',
            parameterValues: [
              [psk24, pw, 'xsd:string'],
              [kp24, pw, 'xsd:string']
            ]
          }, { timeout: 10000 });
          ok = true;
          logger.info(`[updatePassword 2.4G] Enqueued on ${psk24} and ${kp24}`);
        } catch (e) {
          try {
            await instance.post(tasksUrl, {
              name: 'setParameterValues',
              parameterValues: [[psk24, pw, 'xsd:string']]
            }, { timeout: 10000 });
            ok = true;
          } catch (_) {}
          try {
            await instance.post(tasksUrl, {
              name: 'setParameterValues',
              parameterValues: [[kp24, pw, 'xsd:string']]
            }, { timeout: 10000 });
            ok = true;
          } catch (_) {}
        }
      }
    }

    // ── 5 GHz Password ──
    if (shouldUpdate5) {
      if (isTr181) {
        try {
          await instance.post(tasksUrl, {
            name: 'setParameterValues',
            parameterValues: [['Device.WiFi.AccessPoint.2.Security.KeyPassphrase', pw, 'xsd:string']]
          }, { timeout: 10000 });
          ok = true;
        } catch (_) {}
      } else {
        // TR-098 5G Password (Fiberhome HG6145D2/HG6845F3, ZTE, etc.)
        let base5Obj = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5';
        if (flatParams && flatParams['InternetGatewayDevice.LANDevice.2.WLANConfiguration.1.SSID'] !== undefined) {
          base5Obj = 'InternetGatewayDevice.LANDevice.2.WLANConfiguration.1';
        } else if (device && device.InternetGatewayDevice?.LANDevice?.['2']?.WLANConfiguration) {
          base5Obj = 'InternetGatewayDevice.LANDevice.2.WLANConfiguration.1';
        }

        const pskPath = `${base5Obj}.PreSharedKey.1.PreSharedKey`;
        const kpPath = `${base5Obj}.KeyPassphrase`;

        try {
          await instance.post(tasksUrl, {
            name: 'setParameterValues',
            parameterValues: [
              [pskPath, pw, 'xsd:string'],
              [kpPath, pw, 'xsd:string']
            ]
          }, { timeout: 10000 });
          ok = true;
          logger.info(`[updatePassword 5G] Enqueued on ${pskPath} and ${kpPath}`);
        } catch (e) {
          try {
            await instance.post(tasksUrl, {
              name: 'setParameterValues',
              parameterValues: [[pskPath, pw, 'xsd:string']]
            }, { timeout: 10000 });
            ok = true;
          } catch (_) {}
          try {
            await instance.post(tasksUrl, {
              name: 'setParameterValues',
              parameterValues: [[kpPath, pw, 'xsd:string']]
            }, { timeout: 10000 });
            ok = true;
          } catch (_) {}
        }
      }
    }

    // Wake up modem instantly via CWMP Connection Request
    if (ok) {
      try {
        const acsServer = require('./acsServerService');
        if (acsServer && typeof acsServer.triggerConnectionRequest === 'function') {
          acsServer.triggerConnectionRequest(device._id).catch(() => {});
        }
      } catch (_) {}
    }

    // Catat audit trail jika berhasil
    if (ok && actor) {
      auditTrail.logAuditTrail({
        action: 'UPDATE_PASSWORD',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          deviceId: device._id,
          band: targetBand
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return ok;
  } catch (e) {
    logger.error(`[updatePassword] Error: ${e.message}`, e.response?.data || '');
    return false;
  }
}

async function requestRefresh(tag, actor = null) {
  try {
    const device = await resolveDeviceToken(tag);
    if (!device || !device._id) {
      return { ok: false, message: 'Perangkat tidak ditemukan.' };
    }

    const server = device._acs_server_id
      ? genieacsApi.getACSServer(device._acs_server_id)
      : genieacsApi.getACSServer('legacy');
    if (!server) {
      return { ok: false, message: 'Server ACS tidak ditemukan.' };
    }

    if (server.id === 'builtin') {
      try {
        const pending = db.prepare(
          `SELECT COUNT(*) AS c
           FROM acs_tasks
           WHERE device_id = ?
             AND name IN ('refreshObject', 'getParameterValues', 'getParameterNames')
             AND status IN ('pending', 'in_progress')`
        ).get(device._id);
        if (pending && pending.c > 0) {
          return { ok: true, message: 'Sinkronisasi ONU masih berjalan. Mohon tunggu sebentar.' };
        }
      } catch (e) {
        logger.debug(`[CustomerDevice] Unable to check pending ACS tasks for ${device._id}: ${e.message}`);
      }
    }

    const instance = genieacsApi.createAxiosInstance(server);
    const tasksUrl = `/devices/${encodeURIComponent(device._id)}/tasks?connection_request`;
    const refreshObjects = collectRefreshObjects(device);

    for (const objectName of refreshObjects) {
      await instance.post(tasksUrl, { name: 'refreshObject', objectName }, { timeout: 15000 });
    }

    try {
      const acsServer = require('./acsServerService');
      if (acsServer && typeof acsServer.triggerConnectionRequest === 'function') {
        acsServer.triggerConnectionRequest(device._id).catch(() => {});
      }
    } catch (_) {}

    if (actor) {
      auditTrail.logAuditTrail({
        action: 'REFRESH_DEVICE',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          device_id: device._id,
          refreshObjects
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return {
      ok: true,
      message: `Sinkronisasi ONU dimulai. ${refreshObjects.length} jalur TR-069 dipoll.`,
      deviceId: device._id,
      acsServerId: server.id
    };
  } catch (e) {
    logger.error(`[CustomerDevice] Error requesting refresh for ${tag}: ${e.message}`);
    return { ok: false, message: 'Gagal memulai sinkronisasi ONU.' };
  }
}

async function requestReboot(tag, actor = null) {
  const device = await resolveDeviceToken(tag);
  if (!device || !device._id) return { ok: false, message: 'Perangkat tidak ditemukan.' };
  
  const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
  if (!server) return { ok: false, message: 'Server ACS tidak ditemukan.' };
  
  const instance = genieacsApi.createAxiosInstance(server);
  
  try {
    await instance.post(
      `/devices/${encodeURIComponent(device._id)}/tasks`,
      { name: 'reboot', timestamp: new Date().toISOString() }
    );

    // Catat audit trail jika berhasil
    if (actor) {
      auditTrail.logAuditTrail({
        action: 'REBOOT_DEVICE',
        entity_type: 'device',
        entity_id: tag,
        actor_type: actor.type || 'unknown',
        actor_id: actor.id || null,
        actor_name: actor.name || null,
        details: {
          device_id: device._id
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null
      });
    }

    return { ok: true, message: 'Perintah reboot terkirim. Tunggu beberapa menit hingga ONU online.' };
  } catch (e) {
    return { ok: false, message: 'Gagal mengirim reboot ke GenieACS.' };
  }
}

/** Daftar perangkat yang punya minimal satu tag (untuk admin WA). */
async function listDevicesWithTags(limit = 250) {
  const servers = genieacsApi.getAllACSServers();
  const queries = [
    { _tags: { $exists: true, $ne: [] } },
    { _tags: { $exists: true, $not: { $size: 0 } } },
    { '_tags.0': { $exists: true } }
  ];
  const projection = [
    '_id',
    '_tags',
    '_lastInform',
    'DeviceID.SerialNumber',
    'VirtualParameters.pppoeUsername',
    'VirtualParameters.pppUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username._value'
  ].join(',');

  let allDevices = [];
  const maxLimit = Math.max(1, Math.min(parseInt(limit, 10) || 250, 500));

  for (const server of servers) {
    let found = false;
    for (const query of queries) {
      try {
        const instance = genieacsApi.createAxiosInstance(server);
        let response;
        try {
          response = await instance.get(`/devices`, {
            params: {
              query: JSON.stringify(query),
              limit: maxLimit,
              projection
            },
            timeout: 45000
          });
        } catch (e) {
          response = await instance.get(`/api/devices`, {
            params: {
              query: JSON.stringify(query),
              limit: maxLimit,
              projection
            },
            timeout: 45000
          });
        }
        const rows = Array.isArray(response.data) ? response.data : [];
        if (rows.length > 0) {
          rows.forEach(d => {
            d._acs_server_id = server.id;
            d._acs_server_name = server.name;
          });
          allDevices.push(...rows);
          found = true;
          break;
        }
      } catch (e) {
        /* coba query alternatif */
      }
    }
  }
  
  if (allDevices.length > 0) {
    return { ok: true, devices: allDevices.slice(0, limit) };
  }
  
  return { ok: false, devices: [], message: 'Gagal mengambil daftar dari GenieACS.' };
}

/** Mengambil semua perangkat tanpa melihat tag. */
async function listAllDevices(limit = 999999, acsId = null) {
  let servers = genieacsApi.getAllACSServers();
  if (acsId && acsId !== 'all') {
    servers = servers.filter(s => String(s.id) === String(acsId));
  }
  
  let allDevices = [];
  let lastError = null;

  // Query servers in parallel using Promise.allSettled
  const promises = servers.map(async (server) => {
    try {
      const instance = genieacsApi.createAxiosInstance(server);
      const params = {
        limit,
        projection: '_id,_tags,_lastInform,DeviceID.SerialNumber,VirtualParameters,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress,Device.PPP.Interface.1.Username,Device.PPP.Interface.1.ExternalIPAddress,InternetGatewayDevice.DeviceInfo.ModelName,InternetGatewayDevice.DeviceInfo.SoftwareVersion,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations,InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries,Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries,Device.Hosts.HostNumberOfEntries,InternetGatewayDevice.LANDevice.1.Hosts.Host,Device.Hosts.Host'
      };
      let response;
      try {
        response = await instance.get(`/devices`, { params, timeout: 8000 });
      } catch (e) {
        response = await instance.get(`/api/devices`, { params, timeout: 8000 });
      }
      const rows = Array.isArray(response.data) ? response.data : [];
      rows.forEach(d => {
        d._acs_server_id = server.id;
        d._acs_server_name = server.name;
      });
      return rows;
    } catch (e) {
      logger.error(`[CustomerDevice] Error listing devices on ${server.name}: ${e.message}`);
      throw e;
    }
  });

  const results = await Promise.allSettled(promises);
  results.forEach((r) => {
    if (r.status === 'fulfilled') {
      allDevices.push(...r.value);
    } else {
      lastError = r.reason;
    }
  });
  
  if (allDevices.length > 0 || !lastError) {
    return { ok: true, devices: allDevices.slice(0, limit) };
  }
  
  return { ok: false, devices: [], message: 'Gagal mengambil daftar dari GenieACS: ' + (lastError ? lastError.message : 'Unknown error') };
}

async function updateCustomerTag(oldTag, newTag) {
  const device = await findDeviceByTag(oldTag);
  if (!device || !device._id) return { ok: false, message: 'Perangkat tidak ditemukan.' };
  
  const server = device._acs_server_id ? genieacsApi.getACSServer(device._acs_server_id) : genieacsApi.getACSServer('legacy');
  if (!server) return { ok: false, message: 'Server ACS tidak ditemukan.' };
  
  const instance = genieacsApi.createAxiosInstance(server);
  
  try {
    const tags = Array.isArray(device._tags) ? device._tags.filter((t) => t !== oldTag) : [];
    tags.push(newTag);
    await instance.put(
      `/devices/${encodeURIComponent(device._id)}`,
      { _id: device._id, _tags: tags }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, message: 'Gagal mengubah tag.' };
  }
}

module.exports = {
  findDeviceByTag,
  findDeviceByPppoe,
  fetchFullDevice,
  resolveDeviceToken,
  mapDeviceData,
  extractPppoeUser,
  getCustomerDeviceData,
  fallbackCustomer,
  requestRefresh,
  requestDeviceRefresh: requestRefresh,
  updateSSID,
  updatePassword,
  requestReboot,
  updateCustomerTag,
  listDevicesWithTags,
  listAllDevices,
  expandTagCandidates,
  findDeviceWithTagVariants,
  phoneFromPnJid
};
