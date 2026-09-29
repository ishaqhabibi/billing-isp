const express = require('express');
const router = express.Router();
const rawAxios = require('axios');
const db = require('../config/database');
const { getSetting, getSettings } = require('../config/settingsManager');
const sidebarMenuSvc = require('../services/sidebarMenuService');
const customerDevice = require('../services/customerDeviceService');
const mikrotikSvc = require('../services/mikrotikService');
const fs = require('fs');
const path = require('path');
const { createAxiosInstance, isBuiltinAcsEnabled } = require('../config/genieacs');

// Proxy axios to support local built-in ACS proxy
const axios = {
    get: async (url, config = {}) => {
        if (isBuiltinAcsEnabled() && (url.startsWith('local/') || url === 'local')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.get(path, config);
        }
        return rawAxios.get(url, config);
    },
    post: async (url, data, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.post(path, data, config);
        }
        return rawAxios.post(url, data, config);
    },
    delete: async (url, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.delete(path, config);
        }
        return rawAxios.delete(url, config);
    },
    put: async (url, data, config = {}) => {
        if (isBuiltinAcsEnabled() && url.startsWith('local/')) {
            const path = url.replace(/^local/, '');
            const instance = createAxiosInstance({ id: 'builtin', url: 'local' });
            return instance.put(path, data, config);
        }
        return rawAxios.put(url, data, config);
    }
};

// Helper for DB queries (using better-sqlite3)
function getACSServers(id = null) {
    if (isBuiltinAcsEnabled()) {
        const builtinServer = {
            id: 'builtin',
            name: 'Built-in ACS',
            url: 'local',
            status: 'active'
        };
        if (id && id !== 'all') {
            return id === 'builtin' ? [builtinServer] : [];
        }
        return [builtinServer];
    }

    const legacyACS = getLegacyACS();
    const legacyServer = legacyACS.acs_url ? { 
        id: 'legacy', 
        name: 'Default ACS', 
        url: legacyACS.acs_url, 
        username: legacyACS.acs_user, 
        password: legacyACS.acs_pass 
    } : null;

    if (id === 'legacy') return legacyServer ? [legacyServer] : [];

    let query = 'SELECT * FROM genieacs_servers';
    let params = [];
    if (id && id !== 'all') {
        query += ' WHERE id = ?';
        params.push(id);
        const row = db.prepare(query).get(params);
        return row ? [row] : [];
    }
    
    const rows = db.prepare(query).all(params);
    return legacyServer ? [legacyServer, ...rows] : rows;
}

function getLegacyACS() {
    return {
        acs_url: getSetting('genieacs_url', ''),
        acs_user: getSetting('genieacs_username', ''),
        acs_pass: getSetting('genieacs_password', ''),
        acs_vparams: '', // Default empty for now
        acs_path_pppoe: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
        acs_path_ip: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'
    };
}

function getAxiosConfig(server) {
    const config = {
        timeout: 3000, // 3s timeout to prevent page freezing when ACS IP is unreachable
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    if (server.username && server.password) {
        config.auth = {
            username: server.username,
            password: server.password
        };
    }
    return config;
}

// Helper to normalize URL
function normalizeUrl(url) {
    if (!url) return '';
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toBool(value) {
    return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function normalizeSelectionArray(value) {
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return Array.from(new Set(
        items.map(v => String(v || '').trim()).filter(Boolean)
    ));
}

function buildSingleParamTasks(parameterValues) {
    return (parameterValues || [])
        .filter(pv => Array.isArray(pv) && pv.length >= 2 && pv[0])
        .map(pv => ({
            name: 'setParameterValues',
            payload: { parameterValues: [pv] }
        }));
}

function attachWorkflowMeta(taskSpec, workflowMeta) {
    if (!taskSpec || typeof taskSpec !== 'object') return taskSpec;
    const meta = workflowMeta && typeof workflowMeta === 'object' ? workflowMeta : {};
    const next = { ...taskSpec };
    if (next.payload && typeof next.payload === 'object' && !Array.isArray(next.payload)) {
        next.payload = { ...next.payload };
    }

    if (meta.workflowId) {
        next.workflowId = meta.workflowId;
        if (next.payload) next.payload.workflowId = meta.workflowId;
    }
    if (meta.workflowType) {
        next.workflowType = meta.workflowType;
        if (next.payload) next.payload.workflowType = meta.workflowType;
    }
    if (meta.workflowLabel) {
        next.workflowLabel = meta.workflowLabel;
        if (next.payload) next.payload.workflowLabel = meta.workflowLabel;
    }
    if (Array.isArray(next.followup)) {
        next.followup = next.followup.map(item => attachWorkflowMeta(item, meta));
    }
    if (next.payload && Array.isArray(next.payload.followup)) {
        next.payload.followup = next.payload.followup.map(item => attachWorkflowMeta(item, meta));
    }
    return next;
}

function describeAddWanTask(task) {
    const name = String(task?.name || '').trim();
    const payload = task && task.payload && typeof task.payload === 'object' ? task.payload : {};

    if (name === 'addObject') {
        const objectName = String(payload.objectName || payload.object || '');
        if (/WANConnectionDevice\.\{\{wanDeviceInstance\}\}\.(WANPPPConnection|WANIPConnection)/.test(objectName)) {
            return 'Membuat koneksi WAN';
        }
        if (objectName.includes('WANConnectionDevice')) {
            return 'Membuat slot WAN';
        }
    }

    if (name === 'setParameterValues') {
        const firstParam = Array.isArray(payload.parameterValues) && payload.parameterValues[0]
            ? String(payload.parameterValues[0][0] || '')
            : '';
        if (firstParam.includes('DHCPServerEnable')) return 'Mengatur DHCP LAN';
        if (firstParam.includes('WLANConfiguration')) return 'Mengatur Wi-Fi';
        if (/(VLAN|LANBind|SSIDBind)/.test(firstParam)) return 'Mengatur VLAN dan binding';
        if (/(ConnectionType|NATEnabled|Username|Password|Enable)/.test(firstParam)) return 'Mengatur koneksi WAN';
        return 'Menerapkan parameter WAN';
    }

    if (name === 'getParameterValues') return 'Verifikasi hasil provisioning';
    if (name === 'refreshObject') return 'Menyegarkan data perangkat';
    return name || 'Task ACS';
}

function buildBuiltinAddWanWorkflow({
    mode,
    parsedVlan,
    pppoeUser,
    pppoePass,
    dhcp,
    lanPorts,
    wlanSsids,
    configureWifi,
    wifiSsid24,
    wifiPass24,
    wifiSsid5,
    wifiPass5,
    manufacturer,
    wlanConfig,
    workflowMeta
}) {
    const isPppoe = mode === 'pppoe';
    const connectionType = isPppoe ? 'WANPPPConnection' : 'WANIPConnection';
    const lanPortsArray = normalizeSelectionArray(lanPorts);
    const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
    const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}.{{wanConnectionInstance}}`;
    const followup = [];

    const baseParamValues = [
        [`${baseConnPath}.Enable`, true, 'xsd:boolean'],
        [`${baseConnPath}.ConnectionType`, isPppoe ? 'IP_Routed' : 'Bridged', 'xsd:string']
    ];

    if (isPppoe) {
        baseParamValues.push(
            [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
            [`${baseConnPath}.Username`, pppoeUser, 'xsd:string'],
            [`${baseConnPath}.Password`, pppoePass, 'xsd:string']
        );
    }

    followup.push(...buildSingleParamTasks(baseParamValues));

    const vendorParamValues = [];
    if (manufacturer.includes('huawei')) {
        vendorParamValues.push(
            [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
            [`${baseConnPath}.X_HW_WANMode`, isPppoe ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else if (manufacturer.includes('zte')) {
        vendorParamValues.push(
            [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else {
        vendorParamValues.push(
            [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
        );
    }

    followup.push(...buildSingleParamTasks(vendorParamValues));

    followup.push({
        name: 'setParameterValues',
        payload: {
            parameterValues: [[
                'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable',
                toBool(dhcp),
                'xsd:boolean'
            ]]
        }
    });

    const verifyNames = [
        `${baseConnPath}.Enable`,
        `${baseConnPath}.ConnectionType`,
        `${baseConnPath}.ExternalIPAddress`,
        `${baseConnPath}.Uptime`
    ];
    if (isPppoe) {
        verifyNames.push(`${baseConnPath}.Username`, `${baseConnPath}.NATEnabled`);
    }

    const wifiParamValues = [];
    const wlanObj = wlanConfig || {};
    if (toBool(configureWifi)) {
        if (wlanObj['1'] && wifiSsid24) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
            verifyNames.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
            if (wifiPass24) {
                wifiParamValues.push(
                    ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', wifiPass24, 'xsd:string'],
                    ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', wifiPass24, 'xsd:string']
                );
            }
        }

        const fiveGIndex = wlanObj['5'] ? '5' : (wlanObj['2'] ? '2' : null);
        if (fiveGIndex && wifiSsid5) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
            verifyNames.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`);
            if (wifiPass5) {
                wifiParamValues.push(
                    [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                    [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                );
            }
        }
    }

    followup.push(...buildSingleParamTasks(wifiParamValues));
    followup.push({
        name: 'getParameterValues',
        payload: {
            parameterNames: Array.from(new Set(verifyNames))
        }
    });

    return attachWorkflowMeta({
        name: 'addObject',
        objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
        instanceVariable: 'wanDeviceInstance',
        followup: [{
            name: 'addObject',
            payload: {
                objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}`,
                instanceVariable: 'wanConnectionInstance',
                followup
            }
        }]
    }, workflowMeta);
}

// Helper to get nested value like genieacs.js
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

// Standard paths for RX Power
const RX_POWER_PATHS = [
    'VirtualParameters.RXPower',
    'VirtualParameters.RXpower',
    'VirtualParameters.rx_power',
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
    'Device.XPON.Interface.1.Stats.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANDSLDiagnostics.FECOutput' // some devices
];

// PPPoE IP search keys matching user's template
// PPPoE IP search keys matching user's template (prioritizing newest WAN instances)
const PPPOE_IP_KEYS = [
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.2.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.2.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.2.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress',
    'Device.PPP.Interface.3.ExternalIPAddress',
    'Device.PPP.Interface.2.ExternalIPAddress',
    'Device.PPP.Interface.1.ExternalIPAddress',
    'Device.IP.Interface.1.IPv4Address.1.IPAddress'
];

// PPPoE Username search keys matching user's template (prioritizing newest WAN instances)
const PPPOE_USER_KEYS = [
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.1.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username',
    'Device.PPP.Interface.3.Username',
    'Device.PPP.Interface.2.Username',
    'Device.PPP.Interface.1.Username'
];

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
    return '-';
}

function extractPppoeUser(d) {
    const allMatches = [];
    for (const key of PPPOE_USER_KEYS) {
        const matches = getWildcardMatches(d, key);
        for (const match of matches) {
            if (match.value && match.value !== '-' && !allMatches.some(x => x.value === match.value)) {
                let isValid = true;
                if (match.path.includes('WANPPPConnection.')) {
                    const connectionTypePath = match.path.replace('Username', 'ConnectionType');
                    const connTypeMatches = getWildcardMatches(d, connectionTypePath);
                    if (connTypeMatches.length > 0 && connTypeMatches[0].value === 'PPPoE_Bridged') {
                        isValid = false;
                    }
                }
                if (isValid) allMatches.push(match);
            }
        }
    }

    if (allMatches.length === 0) return '-';
    if (allMatches.length === 1) return allMatches[0].value;

    // Jika ada lebih dari satu, utamakan yang ada di tags perangkat (misal hasil provisioning)
    if (Array.isArray(d.tags)) {
        for (const t of d.tags) {
            const found = allMatches.find(m => String(m.value).toLowerCase() === String(t).toLowerCase());
            if (found) return found.value;
        }
    }

    // Default: ambil yang instance-nya paling tinggi (paling baru dibuat)
    return allMatches[0].value;
}

function parseUptimeToSeconds(val) {
    if (!val || val === '-' || val === 'N/A') return 0;
    if (typeof val === 'number') return Math.floor(val);
    const s = String(val).trim();
    if (!isNaN(Number(s))) return parseInt(s, 10);
    
    let total = 0;
    const wMatch = s.match(/(\d+)\s*w/i);
    if (wMatch) total += parseInt(wMatch[1], 10) * 86400 * 7;
    const dMatch = s.match(/(\d+)\s*d/i);
    if (dMatch) total += parseInt(dMatch[1], 10) * 86400;
    const hMatch = s.match(/(\d+)\s*h/i);
    if (hMatch) total += parseInt(hMatch[1], 10) * 3600;
    const mMatch = s.match(/(\d+)\s*m(?!s)/i);
    if (mMatch) total += parseInt(mMatch[1], 10) * 60;
    const sMatch = s.match(/(\d+)\s*s/i);
    if (sMatch) total += parseInt(sMatch[1], 10);

    if (total === 0 && s.includes(':')) {
        const clean = s.replace(/.*d\s*/i, '');
        const parts = clean.split(':').map(p => parseInt(p, 10));
        if (parts.length === 3) {
            total += (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        } else if (parts.length === 2) {
            total += (parts[0] || 0) * 60 + (parts[1] || 0);
        }
    }
    return total;
}

function formatUptime(seconds) {
    if (!seconds || seconds === 'N/A' || seconds === '-') return seconds || '-';
    const totalSecs = parseUptimeToSeconds(seconds);
    if (totalSecs <= 0) return typeof seconds === 'string' ? seconds : '-';
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
    return '-';
}

function formatRxPower(val) {
    if (val === undefined || val === null || val === '-' || val === '') return '-';
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    if (num > 0) {
        const dbVal = 30 + (Math.log10(num * Math.pow(10, -7)) * 10);
        return (Math.ceil(dbVal * 100) / 100).toFixed(2);
    }
    return String(num);
}

function extractRxPower(d) {
    let rxPower = '-';
    for (const path of RX_POWER_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-') {
            rxPower = val;
            break;
        }
    }
    return formatRxPower(rxPower);
}

const TX_POWER_PATHS = [
    'VirtualParameters.getponpower',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_CU_WANEPONInterfaceConfig.OpticalTransceiver.TXPower',
    'Device.Optical.Interface.1.TransmitterOutputPower',
    'Device.XPON.Interface.1.Stats.TXPower'
];

function extractTxPower(d) {
    for (const path of TX_POWER_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') {
            return formatRxPower(val);
        }
    }
    return '-';
}

function extractTemperature(d) {
    const TEMP_PATHS = [
        'VirtualParameters.gettemp',
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.TransceiverTemperature',
        'InternetGatewayDevice.DeviceInfo.TemperatureStatus.TemperatureValue',
        'Device.DeviceInfo.TemperatureStatus.TemperatureValue'
    ];
    for (const path of TEMP_PATHS) {
        const val = getNestedValue(d, path);
        if (val !== undefined && val !== null && val !== '-' && val !== '') {
            const num = parseFloat(val);
            if (!isNaN(num)) return `${Math.round(num)} °C`;
            return String(val);
        }
    }
    return '-';
}

function extractVoltage(d) {
    const VOLT_PATHS = [
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.TransceiverSupplyVoltage',
        'Device.Optical.Interface.1.SupplyVoltage'
    ];
    for (const path of VOLT_PATHS) {
        const val = getNestedValue(d, path);
        if (val !== undefined && val !== null && val !== '-' && val !== '') {
            const num = parseFloat(val);
            if (!isNaN(num)) {
                const volt = num > 100 ? (num / 1000).toFixed(2) : num.toFixed(2);
                return `${volt} V`;
            }
            return String(val);
        }
    }
    return '-';
}

function extractPppoeUptimeInfo(d, activeSessionsMap = null, pppoeUser = null) {
    let baseSecs = 0;
    let rawVal = null;

    if (activeSessionsMap && pppoeUser && pppoeUser !== '-' && pppoeUser !== 'N/A') {
        const u = String(pppoeUser).trim().toLowerCase();
        let session = activeSessionsMap.get(u);
        if (!session && u.includes('@')) {
            session = activeSessionsMap.get(u.split('@')[0]);
        }
        if (session && session.uptime) {
            baseSecs = parseUptimeToSeconds(session.uptime);
            if (baseSecs > 0) {
                return {
                    formatted: formatUptime(baseSecs),
                    seconds: baseSecs
                };
            }
        }
    }

    rawVal = getDeviceParameterValue(d, PPPOE_UPTIME_KEYS, (matchedPath, value, device) => {
        if (value === undefined || value === null || value === '' || value === '-') return false;
        return true;
    });

    if (rawVal && rawVal !== '-') {
        baseSecs = parseUptimeToSeconds(rawVal);
        if (baseSecs > 0) {
            const lastInform = d._lastInform || d.last_inform || d._updatedAt || d.updated_at;
            if (lastInform) {
                const informTime = new Date(lastInform).getTime();
                if (!isNaN(informTime)) {
                    const elapsed = Math.max(0, Math.floor((Date.now() - informTime) / 1000));
                    if (elapsed > 0 && elapsed < 86400 * 30) {
                        baseSecs += elapsed;
                    }
                }
            }
            return {
                formatted: formatUptime(baseSecs),
                seconds: baseSecs
            };
        }
    }

    return {
        formatted: rawVal && isNaN(rawVal) ? String(rawVal) : '-',
        seconds: 0
    };
}

function extractAllWans(device, activeSessionsMap = new Map()) {
    const wans = [];
    const wanConnDevices = getNestedValue(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice');
    if (wanConnDevices && typeof wanConnDevices === 'object') {
        for (const devKey of Object.keys(wanConnDevices)) {
            if (devKey.startsWith('_')) continue;
            const devObj = wanConnDevices[devKey];
            if (!devObj || typeof devObj !== 'object') continue;

            if (devObj.WANPPPConnection) {
                for (const pppKey of Object.keys(devObj.WANPPPConnection)) {
                    if (pppKey.startsWith('_')) continue;
                    const ppp = devObj.WANPPPConnection[pppKey];
                    if (!ppp || typeof ppp !== 'object') continue;
                    const user = ppp.Username?._value || ppp.Username || '-';
                    const ip = ppp.ExternalIPAddress?._value || ppp.ExternalIPAddress || '-';
                    const connType = ppp.ConnectionType?._value || ppp.ConnectionType || 'PPPoE';
                    const enable = ppp.Enable?._value !== false;
                    const vlan = ppp.VLANID?._value || ppp.X_HW_VLAN?._value || ppp.X_ZTE_VLAN?._value || '-';
                    
                    const isSessionActive = user !== '-' && activeSessionsMap.has(user.toLowerCase());
                    
                    wans.push({
                        instance: `${devKey}.${pppKey}`,
                        type: connType,
                        username: user,
                        ip: ip,
                        vlan: vlan,
                        enabled: enable,
                        isActive: isSessionActive || (ip && ip !== '0.0.0.0' && ip !== '-')
                    });
                }
            }

            if (devObj.WANIPConnection) {
                for (const ipKey of Object.keys(devObj.WANIPConnection)) {
                    if (ipKey.startsWith('_')) continue;
                    const ipConn = devObj.WANIPConnection[ipKey];
                    if (!ipConn || typeof ipConn !== 'object') continue;
                    const ip = ipConn.ExternalIPAddress?._value || ipConn.ExternalIPAddress || '-';
                    const connType = ipConn.ConnectionType?._value || ipConn.ConnectionType || 'IPoE';
                    const addressingType = ipConn.AddressingType?._value || 'DHCP';
                    const vlan = ipConn.VLANID?._value || ipConn.X_HW_VLAN?._value || ipConn.X_ZTE_VLAN?._value || '-';
                    
                    wans.push({
                        instance: `${devKey}.${ipKey}`,
                        type: `${connType} (${addressingType})`,
                        username: '-',
                        ip: ip,
                        vlan: vlan,
                        enabled: ipConn.Enable?._value !== false,
                        isActive: ip && ip !== '0.0.0.0' && ip !== '-'
                    });
                }
            }
        }
    }
    return wans;
}

function extractSsid(d) {
    const SSID_PATHS = [
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'Device.WiFi.SSID.1.SSID',
        'Device.WiFi.SSID.2.SSID'
    ];
    for (const path of SSID_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') return val;
    }
    return '-';
}

function extractSoftwareVersion(d) {
    const SW_PATHS = [
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
        'Device.DeviceInfo.SoftwareVersion'
    ];
    for (const path of SW_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') return val;
    }
    return '-';
}

function extractUptimeInfo(d, sessionsMap = null, pppoeUser = null) {
    let rawVal = null;
    const UPTIME_PATHS = [
        'VirtualParameters.getdeviceuptime',
        'InternetGatewayDevice.DeviceInfo.UpTime',
        'Device.DeviceInfo.UpTime'
    ];
    for (const path of UPTIME_PATHS) {
        const val = getNestedValue(d, path);
        if (val && val !== '-' && val !== '') {
            rawVal = val;
            break;
        }
    }

    if (!rawVal || rawVal === '-') {
        rawVal = getDeviceParameterValue(d, PPPOE_UPTIME_KEYS, (matchedPath, value, device) => {
            if (value === undefined || value === null || value === '' || value === '-') return false;
            return true;
        });
    }

    let baseSecs = parseUptimeToSeconds(rawVal);

    if (baseSecs > 0) {
        // Add elapsed seconds since last_inform/updated_at so uptime advances smoothly between informs
        const lastInform = d._lastInform || d.last_inform || d._updatedAt || d.updated_at;
        if (lastInform) {
            const informTime = new Date(lastInform).getTime();
            if (!isNaN(informTime)) {
                const elapsed = Math.max(0, Math.floor((Date.now() - informTime) / 1000));
                if (elapsed > 0 && elapsed < 86400 * 30) {
                    baseSecs += elapsed;
                }
            }
        }
    }

    // ── Hierarchy of Truth: Sync with authoritative MikroTik PPPoE Session ──
    let pppoeSecs = 0;
    if (sessionsMap) {
        let userToFind = pppoeUser && pppoeUser !== '-' && pppoeUser !== 'N/A' ? String(pppoeUser).trim().toLowerCase() : null;
        if (userToFind) {
            let session = sessionsMap.get(userToFind);
            if (!session && userToFind.includes('@')) {
                session = sessionsMap.get(userToFind.split('@')[0]);
            }
            if (session && session.uptime) {
                pppoeSecs = parseUptimeToSeconds(session.uptime);
            }
        }

        // If not found yet, check tags or other identifiers
        if (pppoeSecs === 0 && Array.isArray(d._tags)) {
            for (const t of d._tags) {
                const tagUser = String(t || '').trim().toLowerCase();
                let session = sessionsMap.get(tagUser);
                if (!session && tagUser.includes('@')) {
                    session = sessionsMap.get(tagUser.split('@')[0]);
                }
                if (session && session.uptime) {
                    pppoeSecs = parseUptimeToSeconds(session.uptime);
                    break;
                }
            }
        }
    }

    // Physical law: Modem hardware uptime MUST be >= PPPoE session uptime.
    // Certain modems (e.g. Fiberhome HG6045F3) report CWMP timer / inform interval (~600s = 10m)
    // instead of true hardware uptime. If modem uptime < PPPoE session uptime, we sync with PPPoE (+60s boot margin).
    if (pppoeSecs > 0) {
        if (baseSecs <= 0 || baseSecs < pppoeSecs) {
            baseSecs = pppoeSecs + 60;
        }
    }

    if (baseSecs > 0) {
        return {
            formatted: formatUptime(baseSecs),
            seconds: baseSecs
        };
    }

    return {
        formatted: rawVal && isNaN(rawVal) ? String(rawVal) : '-',
        seconds: 0
    };
}

function extractUptime(d) {
    return extractUptimeInfo(d).formatted;
}

function extractClientCount(d) {
    if (!d) return 0;

    // 1. Collect MACs of genuinely associated Wi-Fi devices from active radio interfaces
    const activeWifiMacs = new Set();
    const wlanConfig = getNestedValue(d, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration');
    if (wlanConfig && typeof wlanConfig === 'object') {
        for (const k of Object.keys(wlanConfig)) {
            if (k.startsWith('_')) continue;
            const band = wlanConfig[k];
            if (!band || typeof band !== 'object') continue;
            const assoc = band.AssociatedDevice;
            if (assoc && typeof assoc === 'object') {
                const entries = Array.isArray(assoc) ? assoc : Object.values(assoc);
                for (const item of entries) {
                    if (!item || typeof item !== 'object') continue;
                    const mac = item.AssociatedDeviceMACAddress?._value || item.AssociatedDeviceMACAddress || 
                                item.MACAddress?._value || item.MACAddress;
                    if (mac && typeof mac === 'string' && mac.length >= 10) {
                        activeWifiMacs.add(mac.toLowerCase());
                    }
                }
            }
        }
    }

    // TR-181 AccessPoint AssociatedDevice
    const tr181APs = getNestedValue(d, 'Device.WiFi.AccessPoint');
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
                    const mac = item.MACAddress?._value || item.MACAddress;
                    if (mac && typeof mac === 'string' && mac.length >= 10) {
                        activeWifiMacs.add(mac.toLowerCase());
                    }
                }
            }
        }
    }

    // 2. Check Hosts list (LAN & Wi-Fi) and count ONLY actively connected clients
    const hostObj = getNestedValue(d, 'InternetGatewayDevice.LANDevice.1.Hosts.Host') ||
                    getNestedValue(d, 'Device.Hosts.Host');
    if (hostObj && typeof hostObj === 'object') {
        let activeCount = 0;
        const hostEntries = Array.isArray(hostObj) ? hostObj : Object.values(hostObj);

        for (const host of hostEntries) {
            if (!host || typeof host !== 'object') continue;
            const getVal = (key) => {
                const v = host[key];
                return (v && typeof v === 'object' && '_value' in v) ? v._value : v;
            };

            const mac = String(getVal('MACAddress') || '').toLowerCase();
            const iface = String(getVal('InterfaceType') || getVal('Layer2Interface') || '').toLowerCase();
            const activeRaw = getVal('Active');
            const isWiFi = iface.includes('802.11') || iface.includes('wlan') || iface.includes('wifi');

            let isActive = false;
            if (isWiFi) {
                // Wi-Fi clients are ONLY genuinely active if currently associated to the radio
                isActive = activeWifiMacs.has(mac);
            } else {
                // Wired LAN Ethernet clients
                isActive = activeRaw === true || activeRaw === 'true' || activeRaw === 1 || activeRaw === '1';
            }

            if (isActive) {
                activeCount++;
            }
        }

        return activeCount;
    }

    // 3. Fallback to active associated Wi-Fi devices if Hosts list was not provided
    if (activeWifiMacs.size > 0) {
        return activeWifiMacs.size;
    }

    // 4. Check TotalAssociations only if explicitly reported and valid
    if (wlanConfig && typeof wlanConfig === 'object') {
        let totalAssoc = 0;
        let hasTotalAssocParam = false;
        for (const k of Object.keys(wlanConfig)) {
            if (k.startsWith('_')) continue;
            const band = wlanConfig[k];
            if (band && typeof band === 'object') {
                const assoc = getNestedValue(band, 'TotalAssociations');
                if (assoc !== null && assoc !== undefined && assoc !== '-') {
                    const num = parseInt(assoc, 10);
                    if (!isNaN(num)) {
                        totalAssoc += num;
                        hasTotalAssocParam = true;
                    }
                }
            }
        }
        if (hasTotalAssocParam) return totalAssoc;
    }

    return 0;
}

// Middleware: Require Admin Session
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.status(403).json({ success: false, message: 'Forbidden' });
};

const requireAdminSession = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect('/admin/login');
};

function company() { return getSetting('company_header', 'ISP Admin'); }

function requireSidebarMenuAccess(menuKey) {
    return (req, res, next) => {
        const access = sidebarMenuSvc.evaluateMenuAccess(menuKey, req.session);
        if (access.allowed) return next();

        if (access.reason === 'hidden') {
            req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" sedang disembunyikan dari sidebar.` };
            return res.redirect('/admin');
        }

        if (access.reason === 'locked') {
            req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" terkunci. Hubungi ${sidebarMenuSvc.getFeatureContactPhone()} untuk mendapatkan password.` };
            return res.redirect('/admin/sidebar-settings');
        }

        req.session._msg = { type: 'error', text: 'Anda tidak memiliki akses ke menu ini.' };
        return res.redirect('/admin');
    };
}

router.use((req, res, next) => {
    res.locals.session = req.session;
    res.locals.sidebarSections = sidebarMenuSvc.getSidebarSections(req.session);
    res.locals.sidebarBottomNavItems = sidebarMenuSvc.getBottomNavItems(req.session);
    res.locals.settings = getSettings();
    res.locals.company = company();
    next();
});

router.use(requireAdminSession, requireSidebarMenuAccess('acs_pro'));

async function getLANHosts(deviceId, serverConfig) {
    try {
        const baseUrl = normalizeUrl(serverConfig.url);
        const [hostsResponse, wifiResponse] = await Promise.all([
            axios.get(`${baseUrl}/devices/`, {
                ...getAxiosConfig(serverConfig),
                params: {
                    query: JSON.stringify({ _id: deviceId }),
                    projection: 'InternetGatewayDevice.LANDevice.1.Hosts'
                }
            }).catch(() => ({ data: [] })),
            axios.get(`${baseUrl}/devices/`, {
                ...getAxiosConfig(serverConfig),
                params: {
                    query: JSON.stringify({ _id: deviceId }),
                    projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice'
                }
            }).catch(() => ({ data: [] }))
        ]);

        const device = Array.isArray(hostsResponse.data) && hostsResponse.data.length > 0 ? hostsResponse.data[0] : null;
        if (!device) return [];

        const hostsData = device.InternetGatewayDevice?.LANDevice?.['1']?.Hosts;
        if (!hostsData) return [];

        let hostArray = [];
        if (hostsData.Host) {
            if (Array.isArray(hostsData.Host)) {
                hostArray = hostsData.Host;
            } else if (typeof hostsData.Host === 'object') {
                hostArray = Object.values(hostsData.Host).filter(v => v && typeof v === 'object');
            }
        }

        const wifiRssiMap = new Map();
        const wifiDevice = Array.isArray(wifiResponse.data) && wifiResponse.data.length > 0 ? wifiResponse.data[0] : null;
        if (wifiDevice) {
            const wlanConfig = wifiDevice.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;
            if (wlanConfig) {
                for (const bandKey of ['1', '5']) {
                    const band = wlanConfig[bandKey];
                    if (!band || !band.AssociatedDevice) continue;

                    let devArray = [];
                    if (Array.isArray(band.AssociatedDevice)) {
                        devArray = band.AssociatedDevice;
                    } else if (typeof band.AssociatedDevice === 'object') {
                        devArray = Object.values(band.AssociatedDevice).filter(v => v && typeof v === 'object');
                    }

                    const bandLabel = bandKey === '5' ? '5GHz' : '2.4GHz';
                    devArray.forEach(dev => {
                        const mac = dev.AssociatedDeviceMACAddress?._value || dev.MACAddress?._value || null;
                        const rssi = dev.X_HW_RSSI?._value || dev.SignalStrength?._value || null;
                        const rate = dev.LastDataTransmitRate?._value || dev.X_HW_TxRate?._value || null;

                        if (mac) {
                            wifiRssiMap.set(mac.toString().toLowerCase(), {
                                rssi: rssi !== null ? parseInt(rssi) : null,
                                rate: rate,
                                band: bandLabel
                            });
                        }
                    });
                }
            }
        }

        return hostArray.map((host, index) => {
            const getHostVal = (key) => {
                const val = host[key];
                if (val && typeof val === 'object' && '_value' in val) return val._value;
                return val;
            };

            const mac = getHostVal('MACAddress') || '-';
            const ip = getHostVal('IPAddress') || '-';
            const hostname = getHostVal('HostName') || 'Unknown';
            const activeRaw = getHostVal('Active');
            const interfaceType = getHostVal('InterfaceType') || '';
            const layer2Interface = getHostVal('Layer2Interface') || '';
            
            let bytesReceived = 0;
            let bytesSent = 0;
            const stats = host['X_HW_Stats'];
            if (stats && typeof stats === 'object') {
                bytesReceived = parseInt(stats.BytesReceived?._value || stats.BytesReceived || 0);
                bytesSent = parseInt(stats.BytesSent?._value || stats.BytesSent || 0);
            }

            const l2Str = layer2Interface.toString().toLowerCase();
            const isWiFi = interfaceType.toString().toLowerCase().includes('802.11') || l2Str.includes('wlan') || l2Str.includes('wifi');
            
            let finalRssi = null;
            let band = l2Str.includes('5') ? '5GHz' : '2.4GHz';
            const macLower = mac.toString().toLowerCase();

            let isAssociated = false;
            if (isWiFi && wifiRssiMap.has(macLower)) {
                const wifiInfo = wifiRssiMap.get(macLower);
                finalRssi = wifiInfo.rssi;
                band = wifiInfo.band;
                isAssociated = true;
            }

            // Wi-Fi clients are only genuinely active if currently associated to the radio
            let isReallyActive = false;
            if (isWiFi) {
                isReallyActive = isAssociated;
            } else {
                isReallyActive = activeRaw === true || activeRaw === 'true' || activeRaw === 1;
            }

            return {
                index: index + 1,
                mac, ip, hostname,
                active: isReallyActive,
                isWiFi, band, rssi: finalRssi,
                bytesReceived, bytesSent
            };
        });
    } catch (err) {
        console.error(`[getLANHosts] Error:`, err.message);
        return [];
    }
}

// ============================================
// DEVICE FETCH HELPERS
// ============================================

async function fetchDevicesFromACS(server, vParams = [], paths = {}, options = {}) {
    const { page = 1, limit = null, activeSessionsMap = null } = options;
    try {
        const baseUrl = normalizeUrl(server.url);
        // Gabungkan proyeksi dasar dengan path pencarian
        let projection = '_id,_lastInform,_ip,_deviceId._Manufacturer,_deviceId._ProductClass,_deviceId._SerialNumber,VirtualParameters,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1,InternetGatewayDevice.LANDevice.1.WLANConfiguration,InternetGatewayDevice.LANDevice.1.Hosts.Host,InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries,InternetGatewayDevice.DeviceInfo.UpTime,Device.WiFi.SSID,Device.WiFi.AccessPoint,Device.Hosts.Host';
        
        const params = { projection };
        if (limit !== null) {
            params.limit = limit + 1;
            params.skip = (page - 1) * limit;
        }

        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params
        });

        if (!Array.isArray(response.data)) return { server, devices: [], hasMore: false };

        const hasMore = limit !== null && response.data.length > limit;
        const devicesData = hasMore ? response.data.slice(0, limit) : response.data;

        const sessionsMap = activeSessionsMap || (await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map()));

        const devices = devicesData.map(d => {
            // Fallback PPPoE
            let pppoeUser = extractPppoeUser(d);

            // Fallback RX Power
            let rxPower = extractRxPower(d);

            // Fallback IP
            let ip = extractPppoeIp(d);

            // Customer Name
            const customerName = getNestedValue(d, 'VirtualParameters.CustomerName') || 
                                getNestedValue(d, 'VirtualParameters.customer_name') || 
                                '-';

            const isOnline = (d._lastInform && (Date.now() - new Date(d._lastInform).getTime() < 900000)) ||
                             (pppoeUser && pppoeUser !== '-' && sessionsMap.has(pppoeUser.toLowerCase()));

            const ssid = extractSsid(d);
            const uptimeInfo = extractUptimeInfo(d, sessionsMap, pppoeUser);
            const clientCount = extractClientCount(d);

            return {
                id: d._id,
                sn: d._deviceId?._SerialNumber || d._id,
                last_inform: d._lastInform,
                isOnline: isOnline,
                manufacturer: d._deviceId?._Manufacturer || '-',
                model: d._deviceId?._ProductClass || '-',
                customer_name: customerName,
                rx_power: rxPower,
                pppoe_user: pppoeUser,
                ip: ip,
                ssid: (ssid && ssid !== '-') ? ssid : (getNestedValue(d, 'VirtualParameters.SSID') || '-'),
                uptime: uptimeInfo.formatted,
                uptime_seconds: uptimeInfo.seconds,
                client_count: clientCount,
                acs_server_name: server.name,
                acs_server_id: server.id
            };
        });

        return { server, devices, hasMore };
    } catch (err) {
        console.error(`[fetchDevicesFromACS] Error on ${server.name}:`, err.message);
        return { server, devices: [], hasMore: false, error: err.message };
    }
}

function enrichDevicesWithCustomerNames(devices) {
    if (!Array.isArray(devices) || devices.length === 0) return devices;

    let customers = [];
    try {
        customers = db.prepare(`
            SELECT id, name, customer_code, genieacs_tag, pppoe_username, hotspot_username, static_ip, ont_sn
            FROM customers
        `).all();
    } catch (e) {
        console.error('[enrichDevicesWithCustomerNames] Error loading customers:', e.message);
        return devices;
    }

    const byTag = new Map();
    const byPppoe = new Map();
    const byHotspot = new Map();
    const byIp = new Map();
    const bySn = new Map();

    for (const c of customers) {
        if (!c.name) continue;
        if (c.ont_sn) {
            const cleanSn = String(c.ont_sn).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            if (cleanSn) bySn.set(cleanSn, c);
        }
        if (c.genieacs_tag) {
            byTag.set(String(c.genieacs_tag).trim().toLowerCase(), c);
            const cleanTag = String(c.genieacs_tag).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            if (cleanTag) bySn.set(cleanTag, c);
        }
        if (c.pppoe_username) {
            const ppp = String(c.pppoe_username).trim().toLowerCase();
            byPppoe.set(ppp, c);
            if (ppp.includes('@')) {
                byPppoe.set(ppp.split('@')[0], c);
            }
        }
        if (c.hotspot_username) byHotspot.set(String(c.hotspot_username).trim().toLowerCase(), c);
        if (c.static_ip) byIp.set(String(c.static_ip).trim().toLowerCase(), c);
    }

    return devices.map(d => {
        let matchedCust = null;

        // 1. Serial Number Match
        const sn = String(d.sn || d.serialNumber || '').trim().toLowerCase();
        const snClean = sn.replace(/[^a-zA-Z0-9]/g, '');
        if (snClean && bySn.has(snClean)) {
            matchedCust = bySn.get(snClean);
        }

        // 2. PPPoE Username Match
        if (!matchedCust) {
            const pppUser = String(d.pppoe_user || d.pppoeUser || d.pppoeUsername || '').trim().toLowerCase();
            if (pppUser && pppUser !== '-' && pppUser !== 'n/a' && byPppoe.has(pppUser)) {
                matchedCust = byPppoe.get(pppUser);
            }
        }

        // 3. Device ID or Tags Match
        if (!matchedCust) {
            const devId = String(d.id || d.phone || '').trim().toLowerCase();
            if (sn && byTag.has(sn)) matchedCust = byTag.get(sn);
            else if (devId && byTag.has(devId)) matchedCust = byTag.get(devId);
            else if (Array.isArray(d.tags)) {
                for (const t of d.tags) {
                    const tagKey = String(t || '').trim().toLowerCase();
                    if (byTag.has(tagKey)) {
                        matchedCust = byTag.get(tagKey);
                        break;
                    }
                    if (byPppoe.has(tagKey)) {
                        matchedCust = byPppoe.get(tagKey);
                        break;
                    }
                }
            }
        }

        // 4. Hotspot Username Match
        if (!matchedCust) {
            const pppUser = String(d.pppoe_user || d.pppoeUser || d.pppoeUsername || '').trim().toLowerCase();
            if (pppUser && byHotspot.has(pppUser)) {
                matchedCust = byHotspot.get(pppUser);
            }
        }

        // 5. IP Address Match
        if (!matchedCust) {
            const ip = String(d.ip || d.pppoe_ip || d.pppoeIP || '').trim().toLowerCase();
            if (ip && ip !== '-' && byIp.has(ip)) {
                matchedCust = byIp.get(ip);
            }
        }

        const finalName = matchedCust ? matchedCust.name : (d.customer_name && d.customer_name !== '-' ? d.customer_name : (d.customerName && d.customerName !== '-' ? d.customerName : '-'));
        const finalCode = matchedCust ? matchedCust.customer_code : (d.customer_code || null);

        return {
            ...d,
            customer_name: finalName,
            customerName: finalName,
            customer_code: finalCode,
            customer_id: matchedCust ? matchedCust.id : (d.customer_id || null)
        };
    });
}

// ============================================
// ROUTES
// ============================================

router.get('/', async (req, res) => {
    try {
        const searchQuery = String(req.query.q || '').trim() || null;
        const acsServers = getACSServers();
        const legacyACS = getLegacyACS();
        const activeSessionsMap = await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map());
        
        const activeServers = acsServers.length > 0 ? acsServers :
            (legacyACS.acs_url ? [{ id: 'legacy', name: 'Default ACS', url: legacyACS.acs_url, username: legacyACS.acs_user, password: legacyACS.acs_pass }] : []);

        const selectedAcsId = req.query.acs || (activeServers[0]?.id);
        const targetServers = selectedAcsId && selectedAcsId !== 'all' ? activeServers.filter(s => String(s.id) === String(selectedAcsId)) : activeServers;

        let allDevices = [];
        if (targetServers.length > 0) {
            if (searchQuery) {
                // Search mode: query devices with search filter
                const query = JSON.stringify({
                    $or: [
                        { '_deviceId._SerialNumber': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.CustomerName': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.customer_name': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.PPPoEUser': { $regex: searchQuery, $options: 'i' } },
                        { '_tags': searchQuery }
                    ]
                });
                
                for (const server of targetServers) {
                    try {
                        const baseUrl = normalizeUrl(server.url);
                        const response = await axios.get(`${baseUrl}/devices`, {
                            ...getAxiosConfig(server),
                            params: { query }
                        });
                        
                        if (Array.isArray(response.data)) {
                            const devices = response.data.map(d => {
                                let rxPower = extractRxPower(d);
                                let pppoeUser = extractPppoeUser(d);
                                let ip = extractPppoeIp(d);
                                const customerName = getNestedValue(d, 'VirtualParameters.CustomerName') ||
                                                    getNestedValue(d, 'VirtualParameters.customer_name') || '-';
                                
                                const isOnline = (d._lastInform && (Date.now() - new Date(d._lastInform).getTime() < 900000)) ||
                                                 (pppoeUser && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase()));
                                
                                const ssid = extractSsid(d);
                                const uptimeInfo = extractUptimeInfo(d, activeSessionsMap, pppoeUser);
                                const clientCount = extractClientCount(d);

                                return {
                                    id: d._id,
                                    sn: d._deviceId?._SerialNumber || d._id,
                                    last_inform: d._lastInform,
                                    isOnline: isOnline,
                                    manufacturer: d._deviceId?._Manufacturer || '-',
                                    model: d._deviceId?._ProductClass || '-',
                                    rx_power: rxPower,
                                    pppoe_ip: ip,
                                    ip: ip,
                                    pppoe_user: pppoeUser,
                                    customer_name: customerName,
                                    ssid: (ssid && ssid !== '-') ? ssid : (getNestedValue(d, 'VirtualParameters.SSID') || '-'),
                                    uptime: uptimeInfo.formatted,
                                    uptime_seconds: uptimeInfo.seconds,
                                    client_count: clientCount,
                                    acs_server_id: server.id,
                                    acs_server_name: server.name
                                };
                            });
                            allDevices = allDevices.concat(devices);
                        }
                    } catch (err) {
                        console.error(`Search error on server ${server.name}:`, err.message);
                    }
                }
            } else {
                // Normal mode: fetch all devices
                const results = await Promise.allSettled(targetServers.map(s => fetchDevicesFromACS(s, [], legacyACS, { activeSessionsMap })));
                results.forEach(r => { if (r.status === 'fulfilled') allDevices = allDevices.concat(r.value.devices); });
            }
        }

        // Enrich devices with matching customer names from Billing DB
        allDevices = enrichDevicesWithCustomerNames(allDevices);

        if (searchQuery) {
            const qLower = searchQuery.toLowerCase();
            allDevices = allDevices.filter(d => 
                String(d.sn || '').toLowerCase().includes(qLower) ||
                String(d.id || '').toLowerCase().includes(qLower) ||
                String(d.customer_name || '').toLowerCase().includes(qLower) ||
                String(d.pppoe_user || '').toLowerCase().includes(qLower) ||
                String(d.ip || d.pppoe_ip || '').toLowerCase().includes(qLower)
            );
        }

        let pppoeProfiles = [];
        try {
            // Get routerId dari query parameter jika ada (untuk multi-router support)
            const selectedRouterId = req.query.router_id ? Number(req.query.router_id) : null;
            pppoeProfiles = await mikrotikSvc.getPppoeProfiles(selectedRouterId);
        } catch (e) {
            console.error('Failed to load PPPoE profiles from MikroTik:', e.message);
        }

        let customersList = [];
        try {
            customersList = db.prepare(`
                SELECT id, customer_code, name, pppoe_username, pppoe_password, wifi_ssid, wifi_password, phone, ont_sn
                FROM customers
                ORDER BY name ASC
            `).all() || [];
        } catch (e) {
            console.error('Failed to load customers for ACS page:', e.message);
        }

        res.render('admin/acs', {
            user: req.session,
            devices: allDevices,
            acsServers: activeServers,
            selectedAcsId,
            searchQuery,
            pppoeProfiles,
            customers: customersList,
            currentPage: 'acs_pro'
        });
    } catch (err) {
        console.error('ACS page error:', err);
        res.render('admin/acs', { user: req.session, devices: [], acsServers: [], selectedAcsId: null, searchQuery: null, pppoeProfiles: [], customers: [], currentPage: 'acs_pro' });
    }
});

router.get('/search', async (req, res, next) => {
    req.url = '/';
    return router.handle(req, res, next);
});

router.get('/device/:deviceId', async (req, res) => {
    try {
        const acsId = String(req.query.acsId || req.query.acs || '').trim() || null;
        const deviceToken = String(req.params.deviceId || '');

        const servers = getACSServers(acsId);
        const targetServers = servers.length > 0 ? servers : getACSServers();

        let deviceData = null;
        let selectedServer = targetServers[0] || { id: 'builtin', name: 'Built-in ACS', url: 'local' };

        // 1. Direct fetch by ID across target servers
        for (const s of targetServers) {
            try {
                const baseUrl = normalizeUrl(s.url);
                const response = await axios.get(`${baseUrl}/devices/${encodeURIComponent(deviceToken)}`, {
                    ...getAxiosConfig(s)
                });
                if (response.data && response.data._id) {
                    deviceData = response.data;
                    selectedServer = s;
                    break;
                }
            } catch (err) {
                // Continue
            }
        }

        // 2. Query filter across target servers
        if (!deviceData) {
            for (const s of targetServers) {
                try {
                    const baseUrl = normalizeUrl(s.url);
                    const response = await axios.get(`${baseUrl}/devices`, {
                        ...getAxiosConfig(s),
                        params: {
                            query: JSON.stringify({
                                $or: [
                                    { _id: deviceToken },
                                    { '_deviceId._SerialNumber': deviceToken },
                                    { _tags: deviceToken }
                                ]
                            }),
                            projection: '_id,_lastInform,_deviceId,_registered,_ip,_tags,_events,VirtualParameters,InternetGatewayDevice,Device'
                        }
                    });
                    if (Array.isArray(response.data) && response.data.length > 0) {
                        deviceData = response.data[0];
                        selectedServer = s;
                        break;
                    }
                } catch (err) {
                    // Continue
                }
            }
        }

        // 3. Fallback to customerDevice lookup if still not found
        if (!deviceData) {
            try {
                const fullDev = await customerDevice.fetchFullDevice(deviceToken);
                if (fullDev && fullDev._id) {
                    deviceData = fullDev;
                    if (fullDev._acs_server_id) {
                        const matchedS = targetServers.find(s => String(s.id) === String(fullDev._acs_server_id));
                        if (matchedS) selectedServer = matchedS;
                    }
                }
            } catch (e) {}
        }

        const activeSessionsMap = await mikrotikSvc.getActivePppoeSessionsMap().catch(() => new Map());

        // 4. Fallback to customerDevice legacy data if raw deviceData not found
        if (!deviceData) {
            const legacyData = await customerDevice.getCustomerDeviceData(deviceToken);
            if (legacyData && (legacyData.phone || legacyData.serialNumber)) {
                const isOnline = String(legacyData.status || '').toLowerCase() === 'online';
                const clients = Array.isArray(legacyData.connectedUsers) ? legacyData.connectedUsers.map(c => ({
                    hostname: c.hostname || 'Unknown',
                    ip: c.ip || '-',
                    mac: c.mac || '-',
                    iface: c.iface || 'LAN',
                    status: c.status || 'Offline',
                    rssi: null
                })) : [];

                return res.render('admin/acs_device', {
                    user: req.session,
                    device: {
                        id: legacyData.phone || deviceToken,
                        phone: legacyData.phone || deviceToken,
                        serialNumber: (legacyData.serialNumber && legacyData.serialNumber !== '-') ? legacyData.serialNumber : deviceToken,
                        vendor: (legacyData.model && legacyData.model !== '-') ? legacyData.model : 'Fiberhome',
                        model: legacyData.productClass || legacyData.model || '-',
                        softwareVersion: legacyData.softwareVersion || '-',
                        hardwareVersion: '-',
                        macAddress: '-',
                        status: isOnline ? 'Online' : 'Offline',
                        lastInform: legacyData.lastInformRaw || legacyData.lastInform || null,
                        registered: null,
                        rxPower: legacyData.rxPower || '-',
                        txPower: '-',
                        temperature: '46 °C',
                        voltage: '3.3 V',
                        pppoeIP: legacyData.pppoeIP || '-',
                        pppoeUsername: legacyData.pppoeUsername || '-',
                        customerName: legacyData.lokasi || '-',
                        uptime: legacyData.uptime || '-',
                        uptime_seconds: parseUptimeToSeconds(legacyData.uptime),
                        pppoeUptime: legacyData.pppoeUptime || '-',
                        pppoe_uptime_seconds: parseUptimeToSeconds(legacyData.pppoeUptime),
                        lanIp: '192.168.1.1',
                        lanMask: '255.255.255.0',
                        dhcpEnabled: true,
                        wifi24: {
                            ssid: (legacyData.ssid24 && legacyData.ssid24 !== '-') ? legacyData.ssid24 : (legacyData.ssid && legacyData.ssid !== '-' ? legacyData.ssid : '-'),
                            channel: 'Auto',
                            enabled: true
                        },
                        wifi5: {
                            ssid: (legacyData.ssid5 && legacyData.ssid5 !== '-') ? legacyData.ssid5 : (legacyData.ssid24 && legacyData.ssid24 !== '-' ? legacyData.ssid24 + ' 5G' : 'Dual-Band 5G'),
                            channel: 'Auto (5GHz)',
                            enabled: !!legacyData.ssid5
                        },
                        allWans: [],
                        ssid: legacyData.ssid24 || legacyData.ssid || '-'
                    },
                    clients,
                    isOnline,
                    acsId: selectedServer.id,
                    acsName: selectedServer.name,
                    currentPage: 'acs_pro'
                });
            }

            return res.status(404).send('Perangkat tidak ditemukan di ACS Server');
        }

        const allWans = extractAllWans(deviceData, activeSessionsMap);

        let pppoeUser = extractPppoeUser(deviceData);
        let ip = extractPppoeIp(deviceData);

        // Prioritize active WAN connected in MikroTik
        const activeWan = allWans.find(w => w.isActive && w.username !== '-');
        if (activeWan) {
            pppoeUser = activeWan.username;
            if (activeWan.ip && activeWan.ip !== '-' && activeWan.ip !== '0.0.0.0') {
                ip = activeWan.ip;
            }
        }
        if (pppoeUser && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase())) {
            const sess = activeSessionsMap.get(pppoeUser.toLowerCase());
            if (sess.ip) ip = sess.ip;
        }

        const lastInform = deviceData._lastInform;
        const isOnline = (lastInform && (Date.now() - new Date(lastInform).getTime() < 900000)) ||
                         (pppoeUser && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase()));

        const rxPower = extractRxPower(deviceData);
        const txPower = extractTxPower(deviceData);
        const temperature = extractTemperature(deviceData);
        const voltage = extractVoltage(deviceData);

        let customerName = getNestedValue(deviceData, 'VirtualParameters.CustomerName') || 
                           getNestedValue(deviceData, 'VirtualParameters.customer_name') || 
                           '-';
        if (customerName === '-' || !customerName) {
            const enriched = enrichDevicesWithCustomerNames([{
                id: deviceData._id,
                sn: deviceData._deviceId?._SerialNumber,
                pppoe_user: pppoeUser,
                ip: ip,
                tags: deviceData._tags
            }]);
            if (enriched && enriched[0] && enriched[0].customer_name && enriched[0].customer_name !== '-') {
                customerName = enriched[0].customer_name;
            }
        }

        const uptimeInfo = extractUptimeInfo(deviceData, activeSessionsMap, pppoeUser);
        const pppoeUptimeInfo = extractPppoeUptimeInfo(deviceData, activeSessionsMap, pppoeUser);

        // Extract Dual-Band Wi-Fi (2.4GHz & 5GHz)
        const wifi24Ssid = getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID') || 
                           getNestedValue(deviceData, 'Device.WiFi.SSID.1.SSID') || 
                           getNestedValue(deviceData, 'VirtualParameters.SSID') || '-';
        const wifi24Channel = getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel') || 'Auto';
        const wifi24Enabled = getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable') !== false;

        let wifi5Ssid = getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID') || 
                        getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.2.WLANConfiguration.1.SSID') || 
                        getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID') || 
                        getNestedValue(deviceData, 'Device.WiFi.SSID.2.SSID');
        if (!wifi5Ssid && (deviceData._deviceId?._ProductClass || '').toLowerCase().includes('hg6045')) {
            wifi5Ssid = wifi24Ssid !== '-' ? (wifi24Ssid.includes('5G') ? wifi24Ssid : wifi24Ssid + ' 5G') : 'Dual-Band (5GHz)';
        }
        const wifi5Channel = getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Channel') || 
                             getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.2.WLANConfiguration.1.Channel') || 'Auto (5GHz)';
        const wifi5Enabled = !!wifi5Ssid;

        const lanIp = getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.IPInterface.1.IPInterfaceIPAddress') || '192.168.1.1';
        const lanMask = getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.IPInterface.1.IPInterfaceSubnetMask') || '255.255.255.0';
        const dhcpEnabled = getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable') !== false;
        const baseMac = getNestedValue(deviceData, 'InternetGatewayDevice.DeviceInfo.MACAddress') || 
                        getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress') || 
                        getNestedValue(deviceData, 'VirtualParameters.MacAddress') || '-';
        const hwVersion = getNestedValue(deviceData, 'InternetGatewayDevice.DeviceInfo.HardwareVersion') || 
                          getNestedValue(deviceData, 'Device.DeviceInfo.HardwareVersion') || '-';

        let rawClients = await getLANHosts(deviceData._id, selectedServer);
        if ((!rawClients || rawClients.length === 0) && deviceData) {
            try {
                const devHosts = deviceData?.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host || deviceData?.Device?.Hosts?.Host;
                if (devHosts && typeof devHosts === 'object') {
                    for (const key in devHosts) {
                        if (!isNaN(key)) {
                            const entry = devHosts[key];
                            const hName = typeof entry?.HostName === 'object' ? entry?.HostName?._value || '-' : entry?.HostName || '-';
                            const hIp = typeof entry?.IPAddress === 'object' ? entry?.IPAddress?._value || '-' : entry?.IPAddress || '-';
                            const hMac = typeof entry?.MACAddress === 'object' ? entry?.MACAddress?._value || '-' : entry?.MACAddress || '-';
                            const hIface = typeof entry?.InterfaceType === 'object' ? entry?.InterfaceType?._value || '-' : entry?.InterfaceType || '-';
                            const isActive = entry?.Active === true || entry?.Active === 'true' || entry?.Active === 1 || entry?.Active?._value === 'true' || entry?.Active?._value === '1';
                            if (hMac && hMac !== '-') {
                                rawClients.push({
                                    hostname: hName,
                                    ip: hIp,
                                    mac: hMac,
                                    iface: hIface,
                                    active: isActive,
                                    isWiFi: hIface.toLowerCase().includes('wifi') || hIface.toLowerCase().includes('802.11'),
                                    band: '2.4GHz',
                                    rssi: null
                                });
                            }
                        }
                    }
                }
            } catch (e) {}
        }

        const clients = (Array.isArray(rawClients) ? rawClients : []).map((c) => ({
            hostname: c.hostname || 'Unknown',
            ip: c.ip || '-',
            mac: c.mac || '-',
            iface: c.isWiFi ? `WiFi ${c.band || ''}`.trim() : 'LAN',
            status: c.active ? 'Online' : 'Offline',
            rssi: typeof c.rssi === 'number' ? c.rssi : null
        }));

        res.render('admin/acs_device', {
            user: req.session,
            device: {
                id: deviceData._id,
                phone: deviceData._id,
                serialNumber: deviceData._deviceId?._SerialNumber || deviceData._id,
                vendor: deviceData._deviceId?._Manufacturer || 'Fiberhome',
                model: deviceData._deviceId?._ProductClass || '-',
                softwareVersion: extractSoftwareVersion(deviceData),
                hardwareVersion: hwVersion,
                macAddress: baseMac,
                status: isOnline ? 'Online' : 'Offline',
                lastInform: lastInform || null,
                registered: deviceData._registered || null,
                rxPower: rxPower,
                txPower: txPower,
                temperature: temperature,
                voltage: voltage,
                pppoeIP: ip,
                pppoeUsername: pppoeUser,
                customerName: customerName,
                uptime: uptimeInfo.formatted,
                uptime_seconds: uptimeInfo.seconds,
                pppoeUptime: pppoeUptimeInfo.formatted,
                pppoe_uptime_seconds: pppoeUptimeInfo.seconds,
                lanIp: lanIp,
                lanMask: lanMask,
                dhcpEnabled: dhcpEnabled,
                wifi24: {
                    ssid: wifi24Ssid,
                    channel: wifi24Channel,
                    enabled: wifi24Enabled
                },
                wifi5: {
                    ssid: wifi5Ssid,
                    channel: wifi5Channel,
                    enabled: wifi5Enabled
                },
                allWans: allWans,
                ssid: wifi24Ssid
            },
            clients,
            isOnline,
            acsId: selectedServer.id,
            acsName: selectedServer.name,
            currentPage: 'acs_pro'
        });
    } catch (err) {
        console.error('Error loading ACS device detail:', err);
        res.status(500).send('Error memuat detail perangkat: ' + err.message);
    }
});

// POST /admin/acs/api/servers
router.post('/api/servers', requireAdmin, async (req, res) => {
    const { name, url, username, password, location } = req.body;
    try {
        db.prepare(
            'INSERT INTO genieacs_servers (name, url, username, password, location) VALUES (?, ?, ?, ?, ?)'
        ).run(name, url, username || null, password || null, location || '');
        res.json({ success: true, message: 'ACS server added' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/acs/api/servers/legacy (Default ACS)
router.put('/api/servers/legacy', requireAdmin, express.json(), async (req, res) => {
    try {
        const url = String(req.body?.url || '').trim();
        if (!url) return res.status(400).json({ success: false, message: 'URL wajib diisi' });
        if (!/^https?:\/\//i.test(url)) return res.status(400).json({ success: false, message: 'URL harus diawali http:// atau https://' });

        const clearUsername = Boolean(req.body?.clear_username);
        const clearPassword = Boolean(req.body?.clear_password);
        const usernameInput = String(req.body?.username || '').trim();
        const passwordInput = String(req.body?.password || '');

        const currentSettings = getSettings();
        currentSettings.genieacs_url = url;

        if (clearUsername) currentSettings.genieacs_username = '';
        else if (usernameInput) currentSettings.genieacs_username = usernameInput;

        if (clearPassword) currentSettings.genieacs_password = '';
        else if (String(passwordInput || '').trim()) currentSettings.genieacs_password = String(passwordInput || '');

        const settingsPath = path.join(__dirname, '../settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf8');

        res.json({ success: true, message: 'Default ACS berhasil diperbarui.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/acs/api/servers/:id
router.put('/api/servers/:id', requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ success: false, message: 'Invalid server id' });

        const name = String(req.body?.name || '').trim();
        const url = String(req.body?.url || '').trim();
        if (!name || !url) return res.status(400).json({ success: false, message: 'Name and URL are required' });

        const existing = db.prepare('SELECT id, password FROM genieacs_servers WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ success: false, message: 'ACS server not found' });

        const usernameRaw = req.body?.username;
        const passwordRaw = req.body?.password;
        const location = String(req.body?.location || '');

        const clearUsername = Boolean(req.body?.clear_username);
        const clearPassword = Boolean(req.body?.clear_password);

        const username = clearUsername ? null : (String(usernameRaw || '').trim() || null);

        let password = existing.password || null;
        if (clearPassword) password = null;
        else if (String(passwordRaw || '').trim()) password = String(passwordRaw || '');

        db.prepare(
            'UPDATE genieacs_servers SET name = ?, url = ?, username = ?, password = ?, location = ? WHERE id = ?'
        ).run(name, url, username, password, location, id);

        res.json({ success: true, message: 'ACS server updated' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /admin/acs/api/servers/:id
router.delete('/api/servers/:id', requireAdmin, async (req, res) => {
    try {
        db.prepare('DELETE FROM genieacs_servers WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'ACS server deleted' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /admin/acs/api/device/:deviceId
router.delete('/api/device/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.delete(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}`,
            getAxiosConfig(server)
        );
        res.json({ success: true, message: 'Device deleted' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/remote-enable/:deviceId
router.post('/api/remote-enable/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.post(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { 
                name: 'setParameterValues',
                parameterValues: [['InternetGatewayDevice.X_HW_Security.AclServices.HTTPWanEnable', true, 'xsd:boolean']]
            },
            { ...getAxiosConfig(server), timeout: 10000 }
        );
        res.json({ success: true, message: 'Remote WAN enabled' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/reboot/:deviceId
router.post('/api/reboot/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.post(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'reboot' },
            { ...getAxiosConfig(server), timeout: 10000 }
        );
        res.json({ success: true, message: 'Reboot command sent' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/refresh/:deviceId
router.post('/api/refresh/:deviceId', requireAdmin, async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '');
        const result = await customerDevice.requestRefresh(deviceId, {
            type: 'admin',
            id: req.session?.adminId || null,
            name: req.session?.username || req.session?.name || 'Admin',
            ip: req.ip,
            userAgent: req.headers['user-agent']
        });
        res.json({ success: !!result.ok, message: result.message });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/bulk/refresh
router.post('/api/bulk/refresh', requireAdmin, async (req, res) => {
    try {
        const { devices } = req.body;
        if (!Array.isArray(devices) || devices.length === 0) {
            return res.status(400).json({ success: false, message: 'Daftar perangkat wajib diisi' });
        }
        
        const promises = devices.map(async (d) => {
            const deviceId = String(d.id || '');
            const result = await customerDevice.requestRefresh(deviceId, {
                type: 'admin',
                id: req.session?.adminId || null,
                name: req.session?.username || req.session?.name || 'Admin',
                ip: req.ip,
                userAgent: req.headers['user-agent']
            });
            return { id: deviceId, success: !!result.ok, message: result.message };
        });
        
        await Promise.allSettled(promises);
        res.json({ success: true, message: `Berhasil mengirim perintah summon untuk ${devices.length} perangkat.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/bulk/delete
router.post('/api/bulk/delete', requireAdmin, async (req, res) => {
    try {
        const { devices } = req.body;
        if (!Array.isArray(devices) || devices.length === 0) {
            return res.status(400).json({ success: false, message: 'Daftar perangkat wajib diisi' });
        }
        
        const promises = devices.map(async (d) => {
            const deviceId = String(d.id || '');
            const acsId = String(d.acsId || '');
            const servers = getACSServers(acsId);
            if (servers.length === 0) return { id: deviceId, success: false, message: 'ACS tidak ditemukan' };
            const server = servers[0];
            const baseUrl = normalizeUrl(server.url);
            
            await axios.delete(
                `${baseUrl}/devices/${encodeURIComponent(deviceId)}`,
                getAxiosConfig(server)
            );
            return { id: deviceId, success: true };
        });
        
        await Promise.allSettled(promises);
        res.json({ success: true, message: `Berhasil menghapus ${devices.length} perangkat.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// POST /admin/acs/api/sync/all
router.post('/api/sync/all', requireAdmin, async (req, res) => {
    try {
        const servers = getACSServers();
        if (servers.length === 0) return res.json({ success: true, message: 'No servers to sync' });
        
        let total = 0;
        for (const s of servers) {
            const result = await fetchDevicesFromACS(s, [], {});
            total += result.devices.length;
            db.prepare('UPDATE genieacs_servers SET device_count = ?, last_sync = (NOW_LOCAL()) WHERE id = ?').run(result.devices.length, s.id);
        }
        res.json({ success: true, message: `Sync complete. Total ${total} devices.` });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /api/clients/:deviceId
router.get('/api/clients/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false });

        const hosts = await getLANHosts(String(deviceId || ''), servers[0]);
        res.json({ success: true, data: hosts });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// GET /admin/acs/api/wifi-settings/:deviceId
router.get('/api/wifi-settings/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;

        // ── 1. Check Builtin ACS first ──
        const builtinDev = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
        if (builtinDev || acsId === 'builtin') {
            let params = {};
            try { params = JSON.parse(builtinDev?.params || '{}'); } catch (_) {}
            const bands = [];

            // 2.4 GHz candidate
            const s24Path = params._wlan_24g_ssid_path 
                         || 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID';
            const s24 = params[s24Path] 
                     || params['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'] 
                     || params['Device.WiFi.SSID.1.SSID'];
            if (s24) {
                bands.push({ index: '1', ssid: s24, name: 'Wi-Fi 2.4GHz', path: s24Path });
            }

            // 5 GHz candidate
            let s5Path = params._wlan_5g_ssid_path || null;
            if (!s5Path) {
                if (params['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID'] !== undefined) {
                    s5Path = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID';
                } else if (params['InternetGatewayDevice.LANDevice.2.WLANConfiguration.1.SSID'] !== undefined) {
                    s5Path = 'InternetGatewayDevice.LANDevice.2.WLANConfiguration.1.SSID';
                } else if (params['InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID'] !== undefined && params['InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID'] === undefined) {
                    s5Path = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID';
                } else if (params['Device.WiFi.SSID.2.SSID'] !== undefined) {
                    s5Path = 'Device.WiFi.SSID.2.SSID';
                }
            }

            const s5 = s5Path ? params[s5Path] : null;
            if (s5) {
                const idx = s5Path.includes('LANDevice.2') ? 'landev2_1' : (s5Path.includes('.2.SSID') ? '2' : '5');
                bands.push({ index: idx, ssid: s5, name: 'Wi-Fi 5GHz', path: s5Path });
            }

            // If 5G was not yet discovered, trigger discovery in background
            if (!s5Path) {
                try {
                    const acsServer = require('../services/acsServerService');
                    acsServer.queueWlanDiscoveryIfNeeded(deviceId, params);
                    acsServer.triggerConnectionRequest(deviceId).catch(() => {});
                } catch (_) {}
            }

            return res.json({ success: true, bands, detected5gPath: s5Path || null });
        }

        // ── 2. External GenieACS ──
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.status(404).json({ success: false, message: 'ACS Server not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        
        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration'
            }
        });
        
        const deviceData = Array.isArray(response.data) && response.data.length > 0 ? response.data[0] : null;
        if (!deviceData) return res.status(404).json({ success: false, message: 'Device not found' });
        
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const bands = [];
        
        // Return all SSID indices (1 to 8) that exist on the ONU
        for (let i = 1; i <= 8; i++) {
            if (wlanConfig[String(i)]) {
                bands.push({
                    index: String(i),
                    ssid: getNestedValue(wlanConfig[String(i)], 'SSID') || `SSID ${i}`,
                    name: i <= 4 ? `Wi-Fi 2.4GHz (SSID ${i})` : `Wi-Fi 5GHz (SSID ${i})`
                });
            }
        }
        
        res.json({ success: true, bands });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /admin/acs/api/wifi/:deviceId
router.post('/api/wifi/:deviceId', requireAdmin, express.json(), async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { ssid, password } = req.body;
        const cleanSsid = ssid ? String(ssid).trim() : null;
        const cleanPass = password ? String(password).trim() : null;

        if (!cleanSsid && !cleanPass) {
            return res.status(400).json({ success: false, error: 'Masukkan nama SSID atau password baru' });
        }
        if (cleanPass && cleanPass.length < 8) {
            return res.status(400).json({ success: false, error: 'Password minimal 8 karakter' });
        }

        let ssidOk = true;
        let passOk = true;
        let errors = [];

        if (cleanSsid) {
            ssidOk = await customerDevice.updateSSID(deviceId, cleanSsid);
            if (!ssidOk) errors.push('Gagal mengubah nama SSID');
        }
        if (cleanPass) {
            passOk = await customerDevice.updatePassword(deviceId, cleanPass);
            if (!passOk) errors.push('Gagal mengubah Password WiFi');
        }

        const success = (cleanSsid ? ssidOk : true) && (cleanPass ? passOk : true);
        res.json({
            success,
            ssidUpdated: Boolean(cleanSsid && ssidOk),
            passwordUpdated: Boolean(cleanPass && passOk),
            message: success ? 'Pengaturan Wi-Fi berhasil diperbarui!' : (errors.join(', ') || 'Gagal memperbarui Wi-Fi'),
            error: errors.length > 0 ? errors.join(', ') : undefined
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /admin/acs/api/device-diagnostics/:deviceId
router.get('/api/device-diagnostics/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const dev = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
        if (!dev) return res.status(404).json({ success: false, message: 'Perangkat tidak ditemukan di Builtin ACS' });

        let params = {};
        try { params = JSON.parse(dev.params || '{}'); } catch (_) {}

        // Filter WLAN related parameters
        const wlanParams = {};
        for (const [k, v] of Object.entries(params)) {
            if (k.includes('WLANConfiguration') || k.includes('WiFi') || k.includes('SSID') || k.startsWith('_wlan')) {
                wlanParams[k] = v;
            }
        }

        // Get last 15 tasks
        const recentTasks = db.prepare(`
            SELECT id, name, payload, status, result, updated_at
            FROM acs_tasks
            WHERE device_id = ?
            ORDER BY id DESC
            LIMIT 15
        `).all(deviceId);

        // Parse payloads and results safely for display
        const formattedTasks = recentTasks.map(t => {
            let parsedPayload = null;
            let parsedResult = null;
            try { parsedPayload = JSON.parse(t.payload || '{}'); } catch (_) {}
            try { parsedResult = JSON.parse(t.result || '{}'); } catch (_) {}
            return {
                id: t.id,
                name: t.name,
                status: t.status,
                payload: parsedPayload,
                result: parsedResult,
                updated_at: t.updated_at
            };
        });

        const s5Path = params._wlan_5g_ssid_path 
            || Object.keys(params).find(k => 
                (k.includes('WLANConfiguration.5.') || k.includes('WiFi.SSID.2.') || (k.includes('LANDevice.2') && k.includes('WLANConfiguration'))) &&
                k.endsWith('.SSID')
            );

        res.json({
            success: true,
            deviceId: dev.id,
            sn: dev.serial_number,
            model: dev.product_class,
            manufacturer: dev.manufacturer,
            ip_address: dev.ip_address,
            last_inform: dev.last_inform,
            detected5gPath: s5Path || null,
            wlanParams,
            recentTasks: formattedTasks
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /admin/acs/api/discover-wlan/:deviceId
router.post('/api/discover-wlan/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const dev = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
        if (!dev) return res.status(404).json({ success: false, message: 'Perangkat tidak ditemukan di Builtin ACS' });

        let params = {};
        try { params = JSON.parse(dev.params || '{}'); } catch (_) {}

        const acsServer = require('../services/acsServerService');
        const now = new Date().toISOString();
        const isTr181 = Object.keys(params).some(k => String(k).startsWith('Device.'));
        const objPath = isTr181 ? 'Device.WiFi.' : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.';

        db.prepare(
            `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
             VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
        ).run(deviceId, JSON.stringify({ objectName: objPath, nextLevel: 0 }), now, now);

        if (!isTr181) {
            db.prepare(
                `INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at)
                 VALUES (?, 'getParameterNames', ?, 'pending', ?, ?)`
            ).run(deviceId, JSON.stringify({ objectName: 'InternetGatewayDevice.LANDevice.', nextLevel: 1 }), now, now);
        }

        // Trigger connection request asynchronously
        try {
            await acsServer.triggerConnectionRequest(deviceId);
        } catch (_) {}

        res.json({ success: true, message: 'Perintah deteksi Wi-Fi dikirim ke antrean modem!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/add-wan-status/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const workflowId = String(req.query.workflowId || '').trim();
        const rootTaskId = parseInt(req.query.rootTaskId, 10);

        if (!workflowId && !Number.isFinite(rootTaskId)) {
            return res.status(400).json({ success: false, message: 'workflowId atau rootTaskId wajib diisi' });
        }

        let rows = [];
        if (workflowId) {
            rows = db.prepare(
                `SELECT id, name, payload, status, result, updated_at
                 FROM acs_tasks
                 WHERE device_id = ?
                   AND payload LIKE ?
                 ORDER BY id ASC
                 LIMIT 200`
            ).all(deviceId, `%"workflowId":"${workflowId}"%`);
        } else {
            rows = db.prepare(
                `SELECT id, name, payload, status, result, updated_at
                 FROM acs_tasks
                 WHERE device_id = ?
                   AND id >= ?
                 ORDER BY id ASC
                 LIMIT 200`
            ).all(deviceId, rootTaskId);
        }

        const tasks = rows.map(row => {
            let payload = {};
            try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
            return {
                id: Number(row.id),
                name: String(row.name || ''),
                status: String(row.status || 'pending'),
                updatedAt: row.updated_at || null,
                label: describeAddWanTask({ name: row.name, payload }),
                payload
            };
        });

        const total = tasks.length;
        const pending = tasks.filter(t => t.status === 'pending').length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const completed = tasks.filter(t => t.status === 'completed').length;
        const failed = tasks.filter(t => t.status === 'failed').length;
        const done = total > 0 && pending === 0 && inProgress === 0;
        const summary = failed > 0
            ? `Ada ${failed} task yang gagal dari ${total} task workflow.`
            : done
                ? `Workflow selesai. ${completed}/${total} task selesai.`
                : `Workflow berjalan. ${completed}/${total} task selesai.`;

        return res.json({
            success: true,
            supported: true,
            workflowId: workflowId || null,
            rootTaskId: Number.isFinite(rootTaskId) ? rootTaskId : null,
            totals: { total, pending, inProgress, completed, failed },
            done,
            hasFailure: failed > 0,
            summary,
            tasks: tasks.map(t => ({
                id: t.id,
                name: t.name,
                status: t.status,
                label: t.label,
                updatedAt: t.updatedAt
            }))
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /admin/acs/api/add-wan/:deviceId
router.post('/api/add-wan/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const {
            acsId,
            mode,
            vlanId,
            pppoeUser,
            pppoePass,
            pppoeProfile,
            autoCreateMikrotik,
            customerId,
            lanPorts,
            wlanSsids,
            configureWifi,
            wifiSsid24,
            wifiPass24,
            wifiSsid5,
            wifiPass5,
            dhcp
        } = req.body;
        
        // 1. Validasi awal
        const normalizedMode = String(mode || '').trim().toLowerCase();
        if (!['pppoe', 'bridge'].includes(normalizedMode)) {
            return res.json({ success: false, message: 'Mode WAN tidak valid' });
        }

        const parsedVlan = parseInt(vlanId, 10);
        if (isNaN(parsedVlan) || parsedVlan < 1 || parsedVlan > 4094) {
            return res.json({ success: false, message: 'VLAN ID tidak valid (harus 1-4094)' });
        }
        
        let trimmedPppoeUser = String(pppoeUser || '').trim();
        const trimmedPppoePass = String(pppoePass || '').trim();
        if (normalizedMode === 'pppoe') {
            if (!trimmedPppoeUser || !trimmedPppoePass) {
                return res.json({ success: false, message: 'Username dan password PPPoE wajib diisi untuk mode PPPoE' });
            }
            // Wajib sertakan domain @bionfiber.net
            const domain = '@bionfiber.net';
            if (!trimmedPppoeUser.toLowerCase().endsWith(domain)) {
                if (trimmedPppoeUser.includes('@')) {
                    trimmedPppoeUser = trimmedPppoeUser.split('@')[0] + domain;
                } else {
                    trimmedPppoeUser = trimmedPppoeUser + domain;
                }
            }
        }
        
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS Server tidak ditemukan' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const config = getAxiosConfig(server);
        
        // 2. Jika Auto-create MikroTik diaktifkan
        if (normalizedMode === 'pppoe' && toBool(autoCreateMikrotik)) {
            try {
                await mikrotikSvc.createPppoeSecret({
                    username: trimmedPppoeUser,
                    password: trimmedPppoePass,
                    profile: pppoeProfile || 'default'
                });
            } catch (mErr) {
                console.error('[AddWAN] Failed to create PPPoE Secret in MikroTik:', mErr.message);
                return res.json({ success: false, message: `Gagal membuat akun PPPoE di MikroTik: ${mErr.message}` });
            }
        }
        
        // 3. Ambil data instansi WANConnectionDevice saat ini untuk menghitung nextInstance
        const getDeviceRes = await axios.get(`${baseUrl}/devices`, {
            ...config,
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: '_id,_deviceId.SerialNumber,_deviceId._SerialNumber,_deviceId.Manufacturer,_deviceId._Manufacturer,InternetGatewayDevice.WANDevice.1.WANConnectionDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration'
            }
        });
        
        const deviceData = Array.isArray(getDeviceRes.data) && getDeviceRes.data.length > 0 ? getDeviceRes.data[0] : null;
        if (!deviceData) return res.json({ success: false, message: 'CPE/Device tidak ditemukan di GenieACS' });

        const deviceSn = String(deviceData._deviceId?._SerialNumber || deviceData._deviceId?.SerialNumber || deviceData._id || deviceId || '').trim();

        // 3b. Sinkronisasi data ke tabel customers di database billing
        try {
            const targetCustId = customerId ? parseInt(customerId, 10) : null;
            if (targetCustId) {
                db.prepare(`
                    UPDATE customers 
                    SET ont_sn = COALESCE(NULLIF(?, ''), ont_sn),
                        pppoe_username = COALESCE(NULLIF(?, ''), pppoe_username),
                        pppoe_password = COALESCE(NULLIF(?, ''), pppoe_password),
                        wifi_ssid = COALESCE(NULLIF(?, ''), wifi_ssid),
                        wifi_password = COALESCE(NULLIF(?, ''), wifi_password),
                        genieacs_tag = COALESCE(NULLIF(?, ''), genieacs_tag)
                    WHERE id = ?
                `).run(deviceSn, trimmedPppoeUser, trimmedPppoePass, wifiSsid24 || '', wifiPass24 || '', trimmedPppoeUser, targetCustId);
            } else if (trimmedPppoeUser) {
                db.prepare(`
                    UPDATE customers
                    SET ont_sn = COALESCE(NULLIF(?, ''), ont_sn),
                        genieacs_tag = COALESCE(NULLIF(?, ''), genieacs_tag)
                    WHERE LOWER(pppoe_username) = LOWER(?) OR LOWER(pppoe_username) = LOWER(?)
                `).run(deviceSn, trimmedPppoeUser, trimmedPppoeUser, trimmedPppoeUser.replace('@bionfiber.net', ''));
            }

            // Tag CPE di GenieACS dengan username PPPoE
            if (trimmedPppoeUser) {
                axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tags/${encodeURIComponent(trimmedPppoeUser)}`, {}, config).catch(() => {});
            }
        } catch (dbErr) {
            console.error('[AddWAN] Gagal sinkronisasi data pelanggan:', dbErr.message);
        }
        
        const manufacturer = (deviceData._deviceId?._Manufacturer || deviceData._deviceId?.Manufacturer || '').toLowerCase();
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const isBuiltinServer = String(server.id || '').trim() === 'builtin' || baseUrl === 'local';

        if (isBuiltinServer) {
            const workflowId = `addwan:${deviceId}:${Date.now()}`;
            const task = buildBuiltinAddWanWorkflow({
                mode: normalizedMode,
                parsedVlan,
                pppoeUser: trimmedPppoeUser,
                pppoePass: trimmedPppoePass,
                dhcp,
                lanPorts,
                wlanSsids,
                configureWifi,
                wifiSsid24,
                wifiPass24,
                wifiSsid5,
                wifiPass5,
                manufacturer,
                wlanConfig,
                workflowMeta: {
                    workflowId,
                    workflowType: 'add_wan',
                    workflowLabel: 'Add WAN'
                }
            });

            const taskRes = await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, task, config);
            const rootTaskId = parseInt(taskRes?.data?._id, 10);
            return res.json({
                success: true,
                message: 'Workflow Add WAN built-in berhasil dikirim. Progress akan dimonitor otomatis.',
                trackingSupported: true,
                workflowId,
                rootTaskId: Number.isFinite(rootTaskId) ? rootTaskId : null
            });
        }

        const wanConnObj = deviceData.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice || {};
        const existingKeys = Object.keys(wanConnObj).map(Number).filter(n => !isNaN(n));
        const nextInstance = existingKeys.length > 0 ? Math.max(...existingKeys) + 1 : 2;

        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'addObject',
            objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.'
        }, config);

        const connectionType = normalizedMode === 'pppoe' ? 'WANPPPConnection' : 'WANIPConnection';
        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'addObject',
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${nextInstance}.${connectionType}.`
        }, config);

        const paramValues = [];
        const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${nextInstance}.${connectionType}.1`;
        paramValues.push([`${baseConnPath}.Enable`, true, 'xsd:boolean']);

        if (normalizedMode === 'pppoe') {
            paramValues.push(
                [`${baseConnPath}.ConnectionType`, 'IP_Routed', 'xsd:string'],
                [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
                [`${baseConnPath}.Username`, trimmedPppoeUser, 'xsd:string'],
                [`${baseConnPath}.Password`, trimmedPppoePass, 'xsd:string']
            );
        } else {
            paramValues.push([`${baseConnPath}.ConnectionType`, 'Bridged', 'xsd:string']);
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: [[`InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable`, toBool(dhcp), 'xsd:boolean']]
        }, config).catch(() => {});

        const lanPortsArray = normalizeSelectionArray(lanPorts);
        const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
        if (manufacturer.includes('huawei')) {
            paramValues.push(
                [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
                [`${baseConnPath}.X_HW_WANMode`, normalizedMode === 'pppoe' ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else if (manufacturer.includes('zte')) {
            paramValues.push(
                [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else {
            paramValues.push(
                [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
            );
        }

        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: paramValues
        }, config);

        if (toBool(configureWifi)) {
            const wifiParamValues = [];
            if (wlanConfig['1'] && wifiSsid24) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
                if (wifiPass24) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey`, wifiPass24, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase`, wifiPass24, 'xsd:string']
                    );
                }
            }

            const fiveGIndex = wlanConfig['5'] ? '5' : (wlanConfig['2'] ? '2' : null);
            if (fiveGIndex && wifiSsid5) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
                if (wifiPass5) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                    );
                }
            }

            if (wifiParamValues.length > 0) {
                await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
                    name: 'setParameterValues',
                    parameterValues: wifiParamValues
                }, config);
            }
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'refreshObject',
            objectName: ''
        }, config).catch(() => {});
        
        res.json({
            success: true,
            message: 'Semua antrean tugas Add WAN (dan Wi-Fi) berhasil dikirimkan ke GenieACS.',
            trackingSupported: false
        });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// GET /admin/acs/search - Redirect to main page with query params
router.get('/search', requireAdminSession, async (req, res) => {
    const { q, acs } = req.query;
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (acs) params.append('acs', acs);
    res.redirect(`/admin/acs?${params.toString()}`);
});

module.exports = router;
