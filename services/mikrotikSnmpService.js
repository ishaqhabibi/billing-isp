const snmp = require('net-snmp');
const db = require('../config/database');
const { logger } = require('../config/logger');

// Cache previous interface octet counters for bps rate calculation
// Key: `${routerId}_${index}`, Value: { inBytes, outBytes, timestamp, rxBps, txBps }
const trafficRateCache = new Map();

// Short TTL result caches to prevent duplicate concurrent SNMP requests from jittering the delta
const telemetryResultCache = new Map();
const routerTelemetryCache = new Map();

// In-flight Promise deduplication to ensure concurrent HTTP requests share a single SNMP query
const inflightTelemetryPromises = new Map();
const inflightRouterPromises = new Map();

function snmpGet(session, oids) {
    return new Promise((resolve) => {
        session.get(oids, (err, varbinds) => {
            if (err) return resolve([]);
            resolve(varbinds || []);
        });
    });
}

function snmpSubtree(session, oid) {
    return new Promise((resolve) => {
        const results = [];
        session.subtree(oid, (vbs) => {
            if (Array.isArray(vbs)) {
                vbs.forEach(v => results.push({ oid: v.oid, value: v.value }));
            }
        }, () => {
            resolve(results);
        });
    });
}

/**
 * Robust High-Capacity (Counter64 / Counter32) octet parser.
 * SNMP ASN.1 DER integer encoding produces variable length buffers (1..8 bytes).
 */
function parseHC(val) {
    if (Buffer.isBuffer(val)) {
        if (val.length === 0) return 0;
        let num = 0n;
        for (let i = 0; i < val.length; i++) {
            num = (num << 8n) | BigInt(val[i]);
        }
        return Number(num);
    }
    return Number(val) || 0;
}

function formatUptime(ticks) {
    const totalSecs = Math.floor(Number(ticks) / 100);
    const d = Math.floor(totalSecs / 86400);
    const h = Math.floor((totalSecs % 86400) / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    return `${d}d ${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
}

function getRouterConfig(routerId = null) {
    if (routerId) {
        const r = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
        if (r) return r;
    }
    return db.prepare('SELECT * FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get() ||
           db.prepare('SELECT * FROM routers ORDER BY id ASC LIMIT 1').get();
}

/**
 * Mengambil telemetry lengkap router via SNMP:
 * CPU Cores, RAM, Disk, Health Sensors (Suhu, Voltase), Uptime, Model, dan Latensi
 */
async function getRouterTelemetry(routerId = null) {
    const router = getRouterConfig(routerId);
    if (!router || !router.host) {
        return {
            isOnline: false,
            error: 'Router tidak ditemukan dalam database.'
        };
    }

    const rKey = String(router.id || 'default');
    const now = Date.now();

    // Reuse recent query result if requested within 2000ms
    const recent = routerTelemetryCache.get(rKey);
    if (recent && (now - recent.timestamp < 2000)) {
        return recent.data;
    }

    // Reuse in-flight promise to avoid duplicate concurrent SNMP sessions
    if (inflightRouterPromises.has(rKey)) {
        return inflightRouterPromises.get(rKey);
    }

    const fetchPromise = (async () => {
        const host = router.host;
        const port = router.snmp_port || 161;
        const community = router.snmp_community || 'public';
        const startTime = Date.now();

        const session = snmp.createSession(host, community, {
            port: port,
            timeout: 2500,
            version: snmp.Version2c
        });

        try {
            const [
                sysBinds,
                cpuBinds,
                storageDescs,
                storageUnits,
                storageSizes,
                storageUseds,
                healthBinds
            ] = await Promise.all([
                snmpGet(session, ['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.5.0']),
                snmpSubtree(session, '1.3.6.1.2.1.25.3.3.1.2'),
                snmpSubtree(session, '1.3.6.1.2.1.25.2.3.1.3'),
                snmpSubtree(session, '1.3.6.1.2.1.25.2.3.1.4'),
                snmpSubtree(session, '1.3.6.1.2.1.25.2.3.1.5'),
                snmpSubtree(session, '1.3.6.1.2.1.25.2.3.1.6'),
                snmpSubtree(session, '1.3.6.1.4.1.14988.1.1.3')
            ]);

            const latencyMs = Date.now() - startTime;

            if (!sysBinds || sysBinds.length === 0 || !sysBinds[0].value) {
                session.close();
                return {
                    isOnline: false,
                    routerId: router.id,
                    routerName: router.name,
                    host: router.host,
                    error: 'Router tidak merespons query SNMP (Timeout atau Community salah)'
                };
            }

            // 1. System Info
            const rawDescr = sysBinds[0]?.value ? sysBinds[0].value.toString() : 'MikroTik RouterOS';
            const uptimeTicks = sysBinds[1]?.value || 0;
            const sysName = sysBinds[2]?.value ? sysBinds[2].value.toString() : router.name;

            let model = 'RouterOS';
            let rosVersion = '';
            if (rawDescr.includes('RouterOS')) {
                const parts = rawDescr.replace('RouterOS', '').trim().split(' ');
                model = parts[0] || 'RouterOS';
                rosVersion = parts.slice(1).join(' ') || '';
            }

            // 2. Multi-Core CPU
            const cpuCores = cpuBinds.map((c, i) => ({
                core: i + 1,
                load: Math.min(100, Math.max(0, Number(c.value) || 0))
            }));
            const avgCpu = cpuCores.length > 0
                ? Math.round(cpuCores.reduce((a, b) => a + b.load, 0) / cpuCores.length)
                : 0;

            // 3. RAM & Storage
            let ram = { totalMB: 0, usedMB: 0, freeMB: 0, percent: 0 };
            let disk = { totalMB: 0, usedMB: 0, freeMB: 0, percent: 0 };

            storageDescs.forEach(d => {
                const idx = d.oid.split('.').pop();
                const name = d.value.toString().toLowerCase();
                const unit = storageUnits.find(u => u.oid.endsWith('.' + idx))?.value || 1024;
                const size = storageSizes.find(s => s.oid.endsWith('.' + idx))?.value || 0;
                const used = storageUseds.find(u => u.oid.endsWith('.' + idx))?.value || 0;
                const totalMB = Math.round((Number(size) * Number(unit)) / 1048576);
                const usedMB = Math.round((Number(used) * Number(unit)) / 1048576);
                const pct = totalMB > 0 ? parseFloat(((usedMB / totalMB) * 100).toFixed(1)) : 0;

                if (name.includes('memory') || name.includes('ram')) {
                    ram = { totalMB, usedMB, freeMB: Math.max(0, totalMB - usedMB), percent: pct };
                } else if (name.includes('disk') || name.includes('flash') || name.includes('nand')) {
                    disk = { totalMB, usedMB, freeMB: Math.max(0, totalMB - usedMB), percent: pct };
                }
            });

            // 4. Health Sensors (MikroTik Health MIB)
            let boardTemp = null;
            let cpuTemp = null;
            let voltage = null;

            // Check RouterOS v7 table sensor (.100.1)
            const sensorNames = healthBinds.filter(h => h.oid.includes('.100.1.2.'));
            sensorNames.forEach(s => {
                const sIdx = s.oid.split('.').pop();
                const sName = s.value.toString().toLowerCase();
                const sVal = healthBinds.find(h => h.oid.endsWith('.100.1.3.' + sIdx))?.value;
                if (sVal !== undefined) {
                    const num = parseFloat(sVal.toString());
                    if (sName.includes('cpu-temperature') || sName.includes('cpu_temp')) {
                        cpuTemp = num;
                    } else if (sName.includes('temperature') || sName.includes('board_temp')) {
                        boardTemp = num;
                    } else if (sName.includes('voltage')) {
                        voltage = num > 100 ? (num / 10).toFixed(1) : num.toFixed(1);
                    }
                }
            });

            // Fallback to legacy OIDs (.11, .14, .8)
            if (boardTemp === null) {
                const h11 = healthBinds.find(h => h.oid.endsWith('.11.0'))?.value;
                if (h11) {
                    const num = parseFloat(h11.toString());
                    boardTemp = num > 100 ? parseFloat((num / 10).toFixed(1)) : num;
                }
            }
            if (cpuTemp === null) {
                const h14 = healthBinds.find(h => h.oid.endsWith('.14.0'))?.value;
                if (h14) {
                    const num = parseFloat(h14.toString());
                    cpuTemp = num > 100 ? parseFloat((num / 10).toFixed(1)) : num;
                }
            }
            if (voltage === null) {
                const h8 = healthBinds.find(h => h.oid.endsWith('.8.0'))?.value;
                if (h8) {
                    const num = parseFloat(h8.toString());
                    voltage = num > 100 ? (num / 10).toFixed(1) : num.toFixed(1);
                }
            }

            session.close();

            const result = {
                isOnline: true,
                routerId: router.id,
                routerName: router.name,
                identity: sysName,
                model: model,
                rawDescr: rawDescr,
                rosVersion: rosVersion,
                uptime: formatUptime(uptimeTicks),
                uptimeSeconds: Math.floor(Number(uptimeTicks) / 100),
                latencyMs,
                cpu: {
                    average: avgCpu,
                    coreCount: cpuCores.length,
                    cores: cpuCores
                },
                ram,
                disk,
                health: {
                    boardTemp: boardTemp !== null ? `${boardTemp} °C` : null,
                    cpuTemp: cpuTemp !== null ? `${cpuTemp} °C` : null,
                    voltage: voltage !== null ? `${voltage} V` : null
                }
            };

            routerTelemetryCache.set(rKey, { timestamp: Date.now(), data: result });
            return result;
        } catch (err) {
            try { session.close(); } catch (_) {}
            logger.error(`[MikroTik SNMP] Telemetry error: ${err.message}`);
            return {
                isOnline: false,
                routerId: router.id,
                routerName: router.name,
                host: router.host,
                error: err.message
            };
        }
    })();

    inflightRouterPromises.set(rKey, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inflightRouterPromises.delete(rKey);
    }
}

/**
 * Mengambil daftar interface, link status, link speed, dan real-time rate (Mbps) via SNMP
 */
async function getInterfacesTelemetry(routerId = null) {
    const router = getRouterConfig(routerId);
    if (!router || !router.host) {
        return { isOnline: false, interfaces: [] };
    }

    const rKey = String(router.id || 'default');
    const now = Date.now();

    // 1. Reuse recent query result if requested within 1200ms
    const recent = telemetryResultCache.get(rKey);
    if (recent && (now - recent.timestamp < 1200)) {
        return recent.data;
    }

    // 2. Reuse ongoing in-flight query promise to prevent concurrent queries to MikroTik
    if (inflightTelemetryPromises.has(rKey)) {
        return inflightTelemetryPromises.get(rKey);
    }

    const fetchPromise = (async () => {
        const host = router.host;
        const port = router.snmp_port || 161;
        const community = router.snmp_community || 'public';

        const session = snmp.createSession(host, community, {
            port: port,
            timeout: 3000,
            version: snmp.Version2c
        });

        try {
            const [
                ifNames,
                ifOperStatus,
                ifHighSpeed,
                ifHCIn,
                ifHCOut
            ] = await Promise.all([
                snmpSubtree(session, '1.3.6.1.2.1.31.1.1.1.1'),
                snmpSubtree(session, '1.3.6.1.2.1.2.2.1.8'),
                snmpSubtree(session, '1.3.6.1.2.1.31.1.1.1.15'),
                snmpSubtree(session, '1.3.6.1.2.1.31.1.1.1.6'),
                snmpSubtree(session, '1.3.6.1.2.1.31.1.1.1.10')
            ]);

            session.close();

            const queryTimestamp = Date.now();
            const interfaces = [];
            let totalRxBps = 0;
            let totalTxBps = 0;

            for (const nameVb of ifNames) {
                const index = nameVb.oid.split('.').pop();
                const name = nameVb.value.toString();
                const statusVal = ifOperStatus.find(s => s.oid.endsWith('.' + index))?.value;
                const isUp = statusVal === 1;
                const speedVal = ifHighSpeed.find(s => s.oid.endsWith('.' + index))?.value;
                const speedMbps = Number(speedVal) || 0;

                const inRaw = ifHCIn.find(s => s.oid.endsWith('.' + index))?.value;
                const outRaw = ifHCOut.find(s => s.oid.endsWith('.' + index))?.value;
                const inBytes = parseHC(inRaw);
                const outBytes = parseHC(outRaw);

                // Compute rate (bps) based on previous sample
                const cacheKey = `${router.id}_${index}`;
                let rxBps = 0;
                let txBps = 0;

                const cached = trafficRateCache.get(cacheKey);
                if (cached) {
                    const deltaSec = (queryTimestamp - cached.timestamp) / 1000;
                    if (deltaSec >= 0.8 && deltaSec < 60) {
                        if (inBytes >= cached.inBytes) {
                            rxBps = Math.max(0, (inBytes - cached.inBytes) * 8 / deltaSec);
                        }
                        if (outBytes >= cached.outBytes) {
                            txBps = Math.max(0, (outBytes - cached.outBytes) * 8 / deltaSec);
                        }
                        // Avoid zeroing out baseline if we got a momentary empty counter on active port
                        if (inBytes > 0 || outBytes > 0 || (cached.inBytes === 0 && cached.outBytes === 0)) {
                            trafficRateCache.set(cacheKey, { inBytes, outBytes, timestamp: queryTimestamp, rxBps, txBps });
                        }
                    } else if (deltaSec < 0.8) {
                        // Re-use already computed rate when requests arrive in rapid succession
                        rxBps = cached.rxBps || 0;
                        txBps = cached.txBps || 0;
                    } else {
                        trafficRateCache.set(cacheKey, { inBytes, outBytes, timestamp: queryTimestamp, rxBps: 0, txBps: 0 });
                    }
                } else {
                    trafficRateCache.set(cacheKey, { inBytes, outBytes, timestamp: queryTimestamp, rxBps: 0, txBps: 0 });
                }

                const rxMbps = parseFloat((rxBps / 1000000).toFixed(2));
                const txMbps = parseFloat((txBps / 1000000).toFixed(2));

                // Categorize interface type
                const lower = name.toLowerCase();
                const isPppoe = lower.includes('pppoe');
                const isVlan = lower.includes('vlan');
                const isBridge = lower.includes('bridge') || lower.includes('br-');
                const isVpn = lower.includes('wg-') || lower.includes('l2tp') || lower.includes('ovpn') || lower.includes('wireguard');
                const isPhysical = lower.includes('ether') || lower.includes('eth') || lower.includes('sfp');

                // Map physical port number if applicable (e.g. ether1 -> 1, sfp -> SFP+ 10G)
                let portBadge = null;
                let portOrder = 99;
                if (isPhysical) {
                    if (lower.includes('olt-uplink') || lower === 'ether1' || lower === 'eth1') {
                        portBadge = 'Port 1 (2.5G)';
                        portOrder = 1;
                    } else if (lower.includes('wan-backup') || lower === 'ether2' || lower === 'eth2') {
                        portBadge = 'Port 2';
                        portOrder = 2;
                    } else if (lower.includes('sfp')) {
                        portBadge = 'SFP+ 10G';
                        portOrder = 9;
                    } else {
                        const m = lower.match(/(?:ether|eth)[-_]?([0-9]+)/);
                        if (m) {
                            portBadge = `Port ${m[1]}`;
                            portOrder = parseInt(m[1], 10) || 90;
                        } else {
                            portBadge = 'Physical';
                        }
                    }
                }

                // Exclude virtual/local loopback from total aggregation
                if (isPhysical || isVlan) {
                    totalRxBps += rxBps;
                    totalTxBps += txBps;
                }

                interfaces.push({
                    index,
                    name,
                    isUp,
                    speedMbps,
                    speedLabel: speedMbps >= 10000 ? '10 Gbps' : (speedMbps >= 2500 ? '2.5 Gbps' : (speedMbps >= 1000 ? '1 Gbps' : (speedMbps > 0 ? `${speedMbps} Mbps` : '-'))),
                    inBytes,
                    outBytes,
                    inGB: parseFloat((inBytes / 1073741824).toFixed(2)),
                    outGB: parseFloat((outBytes / 1073741824).toFixed(2)),
                    rxBps,
                    txBps,
                    rxMbps,
                    txMbps,
                    isPhysical,
                    isPppoe,
                    isVlan,
                    isBridge,
                    isVpn,
                    portBadge,
                    portOrder
                });
            }

            // Sort interfaces: Physical first (ordered by portOrder 1..9), then VLANs/Bridges, then VPNs, then PPPoE
            interfaces.sort((a, b) => {
                if (a.isPhysical && !b.isPhysical) return -1;
                if (!a.isPhysical && b.isPhysical) return 1;
                if (a.isPhysical && b.isPhysical) return a.portOrder - b.portOrder;
                return a.name.localeCompare(b.name);
            });

            const resultData = {
                isOnline: true,
                totalInterfaces: interfaces.length,
                totalRxMbps: parseFloat((totalRxBps / 1000000).toFixed(2)),
                totalTxMbps: parseFloat((totalTxBps / 1000000).toFixed(2)),
                interfaces
            };

            telemetryResultCache.set(rKey, { timestamp: queryTimestamp, data: resultData });
            return resultData;
        } catch (err) {
            try { session.close(); } catch (_) {}
            logger.error(`[MikroTik SNMP] Interfaces error: ${err.message}`);
            return { isOnline: false, interfaces: [], error: err.message };
        }
    })();

    inflightTelemetryPromises.set(rKey, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inflightTelemetryPromises.delete(rKey);
    }
}

/**
 * Mengambil throughput real-time spesifik untuk chart streaming
 */
async function getInterfaceTrafficSample(routerId = null, interfaceName = null) {
    const ifacesRes = await getInterfacesTelemetry(routerId);
    if (!ifacesRes.isOnline || !Array.isArray(ifacesRes.interfaces)) {
        return { rxMbps: 0, txMbps: 0, totalRxMbps: 0, totalTxMbps: 0, timestamp: Date.now() };
    }

    let target = null;
    if (interfaceName && interfaceName !== '__total__') {
        target = ifacesRes.interfaces.find(i => i.name.toLowerCase() === interfaceName.toLowerCase());
    }

    // Default target: sfp-wan-metro or WAN/SFP port or first active physical interface
    if (!target) {
        target = ifacesRes.interfaces.find(i => i.name.toLowerCase().includes('sfp-wan') || i.name.toLowerCase().includes('metro')) ||
                 ifacesRes.interfaces.find(i => i.name.toLowerCase().includes('wan') || i.name.toLowerCase().includes('sfp')) ||
                 ifacesRes.interfaces.find(i => i.isPhysical && i.isUp) ||
                 ifacesRes.interfaces[0];
    }

    const rx = target ? target.rxMbps : 0;
    const tx = target ? target.txMbps : 0;

    return {
        interfaceName: target ? target.name : 'Unknown',
        rxMbps: rx,
        txMbps: tx,
        rxBps: rx * 1000000,
        txBps: tx * 1000000,
        totalRxMbps: ifacesRes.totalRxMbps,
        totalTxMbps: ifacesRes.totalTxMbps,
        timestamp: Date.now()
    };
}

module.exports = {
    getRouterTelemetry,
    getInterfacesTelemetry,
    getInterfaceTrafficSample
};
