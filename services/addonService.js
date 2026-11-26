/**
 * Service: Add-On Speed / Promo PSB Pelanggan
 * Mengelola profil kecepatan sementara (gratis PSB maupun berbayar)
 * dan pemulihan otomatis ke profil paket normal saat kedaluwarsa.
 */
const db = require('../config/database');
const { getCurrentDateInTimezone, getSetting } = require('../config/settingsManager');
const auditTrail = require('./auditTrailService');
const { logger } = require('../config/logger');

const VALID_BILLING_MODES = new Set(['free', 'one_time', 'recurring']);
const VALID_BILLING_ACTIONS = new Set(['add_to_unpaid', 'separate_invoice', 'next_invoice', 'none']);

function formatLocalNow() {
  const now = getCurrentDateInTimezone();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function normalizeExpiredAt(raw) {
  const val = String(raw || '').trim();
  if (!val) throw new Error('Tanggal berakhir add-on wajib diisi');
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return `${val} 23:59:59`;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(val)) {
    const clean = val.replace('T', ' ');
    return clean.length === 16 ? `${clean}:00` : clean;
  }
  throw new Error('Format tanggal berakhir add-on tidak valid');
}

function getActiveAddonByCustomerId(customerId) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  const nowStr = formatLocalNow();
  return db.prepare(`
    SELECT *
    FROM customer_addons
    WHERE customer_id = ?
      AND status = 'active'
      AND datetime(expired_at) >= datetime(?)
    ORDER BY id DESC
    LIMIT 1
  `).get(cid, nowStr) || null;
}

function getAddonsByCustomerId(customerId, limit = 20) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) return [];
  return db.prepare(`
    SELECT *
    FROM customer_addons
    WHERE customer_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(cid, limit);
}

/**
 * Menentukan nama profil PPPoE efektif pelanggan:
 * - Jika sedang ditangguhkan / suspended / inactive -> tidak override isolir.
 * - Jika ada add-on aktif yang belum expired -> gunakan addon_profile.
 * - Jika tidak ada -> gunakan nama paket induknya.
 */
function getEffectiveProfileForCustomer(customer, pkg) {
  if (!customer) return pkg ? pkg.name : 'default';
  const st = String(customer.status || 'active').toLowerCase();
  if (st === 'suspended' || st === 'isolated' || st === 'inactive') {
    return pkg ? pkg.name : 'default';
  }
  const activeAddon = getActiveAddonByCustomerId(customer.id);
  if (activeAddon && activeAddon.addon_profile) {
    return activeAddon.addon_profile;
  }
  return pkg ? pkg.name : 'default';
}

/**
 * Sinkronkan perubahan profil PPPoE ke MikroTik atau kick sesi RADIUS agar rate-limit baru aktif.
 */
async function syncCustomerProfileToNetwork(customer, targetProfile) {
  if (!customer || customer.connection_type !== 'pppoe' || !customer.pppoe_username) return false;
  const st = String(customer.status || 'active').toLowerCase();
  if (st === 'suspended' || st === 'isolated' || st === 'inactive') {
    return false;
  }

  const mikrotikSvc = require('./mikrotikService');
  const radiusEnabled = getSetting('radius_enabled', '0') === '1';
  const isRadius = Number(customer.is_radius) === 1;
  const routerId = customer.router_id || null;

  try {
    if (radiusEnabled && isRadius) {
      const radiusSvc = require('./radiusServerService');
      await radiusSvc.disconnectSession(customer.pppoe_username, null, null);
      logger.info(`[AddOn] RADIUS CoA/Kick sesi '${customer.pppoe_username}' -> profil efektif '${targetProfile}'`);
      return true;
    }

    await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, routerId);
    logger.info(`[AddOn] MikroTik PPPoE '${customer.pppoe_username}' diubah ke profil '${targetProfile}'`);
    return true;
  } catch (err) {
    logger.warn(`[AddOn] Gagal sinkronisasi profil '${targetProfile}' untuk '${customer.pppoe_username}': ${err.message}`);
    return false;
  }
}

/**
 * Terapkan logika penagihan Opsi A saat add-on berbayar diaktifkan.
 */
function applyPaidAddonBilling(addonId, customer, addonProfile, price, expiredAt, billingAction, billingMode) {
  if (price <= 0 || billingMode === 'free' || billingAction === 'none' || billingAction === 'next_invoice') {
    return { billingResult: 'none', invoiceId: null };
  }

  const now = getCurrentDateInTimezone();
  const curMonth = now.getMonth() + 1;
  const curYear = now.getFullYear();
  const expShort = String(expiredAt).slice(0, 10);
  const addonNote = `Add-On Speed ${addonProfile} (s.d ${expShort}): Rp ${price.toLocaleString('id-ID')}`;

  if (billingAction === 'add_to_unpaid') {
    // Prioritaskan invoice unpaid bulan berjalan, lalu invoice unpaid terbaru
    let unpaid = db.prepare(`
      SELECT * FROM invoices
      WHERE customer_id = ? AND status = 'unpaid' AND period_month = ? AND period_year = ?
      ORDER BY id DESC LIMIT 1
    `).get(customer.id, curMonth, curYear);

    if (!unpaid) {
      unpaid = db.prepare(`
        SELECT * FROM invoices
        WHERE customer_id = ? AND status = 'unpaid'
        ORDER BY period_year DESC, period_month DESC, id DESC LIMIT 1
      `).get(customer.id);
    }

    if (unpaid) {
      const newAmount = (Number(unpaid.amount) || 0) + price;
      const newNotes = unpaid.notes ? `${unpaid.notes} | + ${addonNote}` : addonNote;
      db.prepare('UPDATE invoices SET amount = ?, notes = ? WHERE id = ?').run(newAmount, newNotes, unpaid.id);
      db.prepare('UPDATE customer_addons SET billed_invoice_id = ? WHERE id = ?').run(unpaid.id, addonId);
      return { billingResult: 'added_to_unpaid', invoiceId: unpaid.id };
    }
    // Jika tidak ada invoice unpaid, fallback ke buat tagihan terpisah
    billingAction = 'separate_invoice';
  }

  if (billingAction === 'separate_invoice') {
    const ins = db.prepare(`
      INSERT INTO invoices (customer_id, period_month, period_year, amount, status, notes)
      VALUES (?, ?, ?, ?, 'unpaid', ?)
    `).run(customer.id, curMonth, curYear, price, addonNote);
    const invId = ins.lastInsertRowid;
    db.prepare('UPDATE customer_addons SET billed_invoice_id = ? WHERE id = ?').run(invId, addonId);
    return { billingResult: 'created_separate_invoice', invoiceId: invId };
  }

  return { billingResult: 'next_invoice', invoiceId: null };
}

/**
 * Mengaktifkan atau memperbarui Add-On Speed pelanggan.
 */
async function activateCustomerAddon(customerId, opts = {}) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Customer ID tidak valid');

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');

  const addonProfile = String(opts.addon_profile || '').trim();
  if (!addonProfile) throw new Error('Profile MikroTik tujuan untuk add-on wajib dipilih');

  const expiredAt = normalizeExpiredAt(opts.expired_at);
  const nowStr = formatLocalNow();
  if (expiredAt <= nowStr) {
    throw new Error('Tanggal berakhir add-on harus lebih besar dari waktu sekarang');
  }

  let billingMode = String(opts.billing_mode || 'free').trim().toLowerCase();
  if (!VALID_BILLING_MODES.has(billingMode)) billingMode = 'free';

  let price = billingMode === 'free' ? 0 : Math.max(0, Math.round(Number(opts.price) || 0));
  if (price === 0 && billingMode !== 'free') {
    billingMode = 'free';
  }

  let billingAction = String(opts.billing_action || 'next_invoice').trim().toLowerCase();
  if (!VALID_BILLING_ACTIONS.has(billingAction)) billingAction = 'next_invoice';
  if (billingMode === 'free' || price === 0) billingAction = 'none';

  const pkg = customer.package_id
    ? db.prepare('SELECT * FROM packages WHERE id = ?').get(customer.package_id)
    : null;
  const originalProfile = String(opts.original_profile || (pkg ? pkg.name : '') || 'default').trim();
  const notes = String(opts.notes || '').trim();
  const createdBy = String(opts.created_by || 'Admin').trim();

  // Batalkan add-on aktif sebelumnya jika ada agar hanya ada 1 add-on aktif per pelanggan
  db.prepare(`
    UPDATE customer_addons
    SET status = 'cancelled', expired_processed_at = NOW_LOCAL()
    WHERE customer_id = ? AND status = 'active'
  `).run(cid);

  const res = db.prepare(`
    INSERT INTO customer_addons (customer_id, addon_profile, original_profile, price, billing_mode, billing_action, start_at, expired_at, status, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(cid, addonProfile, originalProfile, price, billingMode, billingAction, nowStr, expiredAt, notes, createdBy);

  const addonId = res.lastInsertRowid;
  const billingInfo = applyPaidAddonBilling(addonId, customer, addonProfile, price, expiredAt, billingAction, billingMode);

  if (!opts.skipNetworkSync) {
    await syncCustomerProfileToNetwork(customer, addonProfile);
  }

  try {
    auditTrail.logAuditTrail({
      actor_name: createdBy,
      actor_type: 'admin',
      action: 'ADDON_ACTIVATE',
      entity_type: 'customer',
      entity_id: String(cid),
      details: { message: `Add-On '${addonProfile}' (${billingMode}, Rp ${price.toLocaleString('id-ID')}) s.d ${expiredAt} untuk ${customer.name}` }
    });
  } catch (_) {}

  return {
    addon: db.prepare('SELECT * FROM customer_addons WHERE id = ?').get(addonId),
    billingInfo
  };
}

/**
 * Menghentikan add-on aktif secara manual dan mengembalikan profil ke paket normal.
 */
async function cancelCustomerAddon(customerId, addonId = null, actorName = 'Admin') {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('Customer ID tidak valid');

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');

  const activeAddon = addonId
    ? db.prepare("SELECT * FROM customer_addons WHERE id = ? AND customer_id = ? AND status = 'active'").get(Number(addonId), cid)
    : getActiveAddonByCustomerId(cid);

  if (!activeAddon) return { cancelled: false };

  db.prepare(`
    UPDATE customer_addons
    SET status = 'cancelled', expired_processed_at = NOW_LOCAL()
    WHERE id = ?
  `).run(activeAddon.id);

  const pkg = customer.package_id
    ? db.prepare('SELECT * FROM packages WHERE id = ?').get(customer.package_id)
    : null;
  const restoreProfile = (pkg && pkg.name) ? pkg.name : (activeAddon.original_profile || 'default');

  await syncCustomerProfileToNetwork(customer, restoreProfile);

  try {
    auditTrail.logAuditTrail({
      actor_name: actorName,
      actor_type: 'admin',
      action: 'ADDON_CANCEL',
      entity_type: 'customer',
      entity_id: String(cid),
      details: { message: `Add-On '${activeAddon.addon_profile}' dihentikan, kembali ke '${restoreProfile}' untuk ${customer.name}` }
    });
  } catch (_) {}

  return { cancelled: true, restoredProfile: restoreProfile };
}

/**
 * Dipanggil berkala oleh Cron: memulihkan secara diam-diam (tanpa notif WA)
 * semua pelanggan yang add-on speed-nya sudah melewati expired_at.
 */
async function processExpiredAddons() {
  const nowStr = formatLocalNow();
  const expiredRows = db.prepare(`
    SELECT a.*, c.id as cust_id, c.name as customer_name, c.pppoe_username, c.router_id,
           c.connection_type, c.status as customer_status, c.is_radius, c.package_id,
           p.name as package_name
    FROM customer_addons a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN packages p ON p.id = c.package_id
    WHERE a.status = 'active'
      AND datetime(a.expired_at) <= datetime(?)
  `).all(nowStr);

  if (!expiredRows || expiredRows.length === 0) return { processed: 0 };

  let processed = 0;
  for (const row of expiredRows) {
    try {
      db.prepare(`
        UPDATE customer_addons
        SET status = 'expired', expired_processed_at = ?
        WHERE id = ?
      `).run(nowStr, row.id);

      const st = String(row.customer_status || 'active').toLowerCase();
      // Hanya pulihkan ke profil normal jika akun pelanggan aktif (jangan buka akun yang sedang terisolir!)
      if (st === 'active' || st === 'ditangguhkan') {
        const restoreProfile = row.package_name || row.original_profile || 'default';
        await syncCustomerProfileToNetwork({
          id: row.cust_id,
          pppoe_username: row.pppoe_username,
          router_id: row.router_id,
          connection_type: row.connection_type,
          status: row.customer_status,
          is_radius: row.is_radius
        }, restoreProfile);
        logger.info(`[AddOn-Cron] Add-On #${row.id} (${row.addon_profile}) untuk '${row.customer_name}' expired -> diam-diam kembali ke '${restoreProfile}'.`);
      } else {
        logger.info(`[AddOn-Cron] Add-On #${row.id} untuk '${row.customer_name}' ditandai expired (status pelanggan ${st}, profil jaringan tidak diubah).`);
      }

      processed++;
    } catch (err) {
      logger.error(`[AddOn-Cron] Gagal memproses expired add-on #${row.id}: ${err.message}`);
    }
  }

  return { processed };
}

/**
 * Mengambil add-on berbayar yang siap masuk ke invoice periode (month/year) pelanggan.
 */
function getBillableAddonsForPeriod(customerId, periodMonth, periodYear) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) return [];

  const padMonth = String(periodMonth).padStart(2, '0');
  const periodStart = `${periodYear}-${padMonth}-01 00:00:00`;
  const nowStr = formatLocalNow();

  return db.prepare(`
    SELECT *
    FROM customer_addons
    WHERE customer_id = ?
      AND price > 0
      AND billing_mode IN ('one_time', 'recurring')
      AND (
        (billing_mode = 'one_time' AND billed_invoice_id IS NULL AND status IN ('active', 'expired'))
        OR
        (billing_mode = 'recurring' AND status = 'active' AND datetime(expired_at) >= datetime(?) AND datetime(expired_at) >= datetime(?))
      )
    ORDER BY id ASC
  `).all(cid, periodStart, nowStr);
}

function linkAddonsToInvoice(addonIds, invoiceId) {
  if (!Array.isArray(addonIds) || addonIds.length === 0 || !invoiceId) return;
  const stmt = db.prepare("UPDATE customer_addons SET billed_invoice_id = ? WHERE id = ? AND billing_mode = 'one_time' AND billed_invoice_id IS NULL");
  for (const id of addonIds) {
    stmt.run(invoiceId, id);
  }
}

module.exports = {
  formatLocalNow,
  normalizeExpiredAt,
  getActiveAddonByCustomerId,
  getAddonsByCustomerId,
  getEffectiveProfileForCustomer,
  syncCustomerProfileToNetwork,
  activateCustomerAddon,
  cancelCustomerAddon,
  processExpiredAddons,
  getBillableAddonsForPeriod,
  linkAddonsToInvoice
};
