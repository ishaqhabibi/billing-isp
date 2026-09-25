/**
 * Service: PDF Invoice Generator
 * Generates Tier-1 ISP professional PDF invoices using PDFKit
 * with clean layout, dynamic text-flow, tax breakdown, verification QR code & digital seal.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('../config/database');

/**
 * Format date to standard Indonesian long format (e.g. 25 September 2026)
 */
function formatIndoDate(dateInput) {
  if (!dateInput) return '-';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  const m = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return `${d.getDate()} ${m[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Konversi angka ke terbilang rupiah baku
 */
function terbilang(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'Nol Rupiah';
  const satuan = ['', 'Satu', 'Dua', 'Tiga', 'Empat', 'Lima', 'Enam', 'Tujuh', 'Delapan', 'Sembilan', 'Sepuluh', 'Sebelas'];
  function konversi(num) {
    if (num < 12) return satuan[num];
    if (num < 20) return konversi(num - 10) + ' Belas';
    if (num < 100) return konversi(Math.floor(num / 10)) + ' Puluh ' + (num % 10 ? konversi(num % 10) : '');
    if (num < 200) return 'Seratus ' + (num - 100 ? konversi(num - 100) : '');
    if (num < 1000) return konversi(Math.floor(num / 100)) + ' Ratus ' + (num % 100 ? konversi(num % 100) : '');
    if (num < 2000) return 'Seribu ' + (num - 1000 ? konversi(num - 1000) : '');
    if (num < 1000000) return konversi(Math.floor(num / 1000)) + ' Ribu ' + (num % 1000 ? konversi(num % 1000) : '');
    if (num < 1000000000) return konversi(Math.floor(num / 1000000)) + ' Juta ' + (num % 1000000 ? konversi(num % 1000000) : '');
    if (num < 1000000000000) return konversi(Math.floor(num / 1000000000)) + ' Miliar ' + (num % 1000000000 ? konversi(num % 1000000000) : '');
    return '';
  }
  return (konversi(n) + ' Rupiah').replace(/\s+/g, ' ').trim();
}

/**
 * Generate PDF Invoice Buffer
 * @param {Object} invoice
 * @param {Object} customer
 * @param {Object} settings
 * @returns {Promise<Buffer>}
 */
function generateInvoicePdfBuffer(invoice, customer, settings = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `Invoice #INV-${String(invoice.id).padStart(4, '0')}`,
          Author: settings.company_header || 'BIONFIBER NETWORK',
          Subject: 'Faktur Tagihan Layanan Internet'
        }
      });

      const buffers = [];
      doc.on('data', b => buffers.push(b));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', err => reject(err));

      const companyName = settings.company_header
        ? (settings.company_header + (settings.company_header.includes('NETWORK') ? '' : ' NETWORK'))
        : (settings.company_name || 'BIONFIBER NETWORK');
      const companyAddress = settings.company_address || 'Pusat Layanan Internet Terpercaya';
      const companyPhone = (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0)
        ? '+' + settings.whatsapp_admin_numbers[0]
        : (settings.company_phone || '-');
      const managerName = settings.company_manager || 'Ishaq Habibi';

      const year = invoice.period_year || new Date().getFullYear();
      const invNo = `INV-${String(invoice.id).padStart(4, '0')}-${year}`;
      const isPaid = (invoice.status === 'paid');

      const mFull = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      const mShort = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
      const periodMonthIdx = (invoice.period_month || 1) - 1;
      const periodStr = `${mFull[periodMonthIdx] || mShort[periodMonthIdx]} ${invoice.period_year || year}`;

      // Formatting dates
      const issueDateStr = formatIndoDate(invoice.created_at || invoice.created_date || new Date());
      const paidDateStr = isPaid && invoice.paid_at 
        ? formatIndoDate(invoice.paid_at) 
        : (invoice.due_date ? formatIndoDate(invoice.due_date) : '-');

      // Payment method (NO "Kasir: Admin")
      let paymentMethodStr = 'QRIS / Transfer Bank';
      if (invoice.payment_gateway) {
        paymentMethodStr = invoice.payment_gateway.toUpperCase();
      } else if (invoice.paid_by_name && invoice.paid_by_name.toLowerCase().includes('cash')) {
        paymentMethodStr = 'Tunai / Offline';
      } else if (invoice.paid_by_name && invoice.paid_by_name.toLowerCase() !== 'admin') {
        paymentMethodStr = invoice.paid_by_name;
      }

      // Design Tokens
      const primaryColor = '#2563eb';
      const accentCyan = '#06b6d4';
      const darkText = '#0f172a';
      const mutedText = '#64748b';
      const lightBg = '#f8fafc';
      const borderColor = '#e2e8f0';
      const statusColor = isPaid ? '#059669' : '#dc2626';
      const statusText = isPaid ? 'LUNAS' : 'BELUM BAYAR';

      // ── Tax & Package Computation ──
      let pkg = null;
      try {
        if (customer && customer.package_id) {
          pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(customer.package_id);
        } else if (invoice && invoice.customer_id) {
          const custRow = db.prepare('SELECT package_id FROM customers WHERE id = ?').get(invoice.customer_id);
          if (custRow && custRow.package_id) {
            pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(custRow.package_id);
          }
        }
      } catch (e) {}

      const totalAmount = Number(invoice.amount || 0);
      const pkgName = (customer && customer.package_name) || (pkg && pkg.name) || (invoice && invoice.package_name) || 'Internet Broadband Unlimited';

      const usePpn = (pkg && pkg.use_ppn === 1) || (customer && customer.use_ppn === 1) || (invoice && invoice.use_ppn === 1);
      const ppnRate = Number((pkg && pkg.ppn_percentage) || (customer && customer.ppn_percentage) || (invoice && invoice.ppn_percentage) || 11.0);
      const useUso = (pkg && pkg.use_uso === 1) || (customer && customer.use_uso === 1) || (invoice && invoice.use_uso === 1);
      const usoRate = useUso ? Number((pkg && pkg.uso_percentage) || (customer && customer.uso_percentage) || 1.75) : 0;
      const combinedTaxPct = ppnRate + usoRate;

      let dpp = totalAmount;
      let ppnAmount = 0;
      let usoAmount = 0;
      const taxMode = usePpn ? 'excluded' : 'included';

      if (combinedTaxPct > 0) {
        dpp = Math.round(totalAmount / (1 + (combinedTaxPct / 100)));
        ppnAmount = Math.round(dpp * (ppnRate / 100));
        usoAmount = useUso ? Math.round(dpp * (usoRate / 100)) : 0;
        dpp = totalAmount - ppnAmount - usoAmount;
      }

      // 1. Top Modern Dual-Tone Accent Bar
      doc.rect(0, 0, 420, 5).fill(primaryColor);
      doc.rect(420, 0, 175.28, 5).fill(accentCyan);

      // ── BACKGROUND WATERMARK (SOFT OPACITY) ──
      doc.save();
      const watermarkColor = isPaid ? '#059669' : '#dc2626';
      const cx = 297.64;
      const cy = 370;
      doc.rotate(-18, { origin: [cx, cy] });

      const boxW = isPaid ? 240 : 340;
      const boxH = 64;
      const boxX = cx - (boxW / 2);
      const boxY = cy - (boxH / 2);

      doc.lineWidth(2.5).strokeColor(watermarkColor).opacity(0.045).roundedRect(boxX, boxY, boxW, boxH, 10).stroke();
      doc.fillColor(watermarkColor).opacity(0.05)
         .fontSize(isPaid ? 38 : 32).font('Helvetica-Bold')
         .text(statusText, boxX, boxY + (isPaid ? 14 : 17), { width: boxW, align: 'center', characterSpacing: isPaid ? 6 : 3 });
      doc.restore();

      // 2. Header Area
      let y = 28;

      // Logo
      const logoPath = path.join(__dirname, '../public/img/logo.png');
      let logoDrawn = false;
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, 40, y, { fit: [130, 42] });
          logoDrawn = true;
        } catch (e) {}
      }

      if (!logoDrawn) {
        doc.roundedRect(40, y, 42, 42, 8).fill(primaryColor);
        doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold')
           .text(companyName.charAt(0).toUpperCase(), 40, y + 11, { width: 42, align: 'center' });
      }

      // Company Info Text
      const compX = logoDrawn ? 180 : 92;
      doc.fillColor(darkText).fontSize(13).font('Helvetica-Bold').text(companyName, compX, y);

      const compAddrY = y + 17;
      doc.fillColor(mutedText).fontSize(8).font('Helvetica')
         .text(companyAddress, compX, compAddrY, { width: 200, lineGap: 1.5 });

      const afterAddrY = doc.y + 2;
      doc.fillColor(mutedText).fontSize(8).font('Helvetica')
         .text(`Telp/WA: ${companyPhone}`, compX, afterAddrY, { width: 200 });

      const leftHeaderBottom = doc.y;

      // Header Right: Title & Invoice Meta
      doc.fillColor(primaryColor).fontSize(20).font('Helvetica-Bold').text('INVOICE', 390, y, { align: 'right', width: 165 });
      doc.fillColor(darkText).fontSize(10.5).font('Helvetica-Bold').text(`# ${invNo}`, 390, y + 25, { align: 'right', width: 165 });

      // Status Badge Box
      const badgeW = isPaid ? 75 : 95;
      const badgeX = 555 - badgeW;
      const badgeY = y + 42;
      doc.roundedRect(badgeX, badgeY, badgeW, 20, 10).fillAndStroke(isPaid ? '#ecfdf5' : '#fef2f2', isPaid ? '#a7f3d0' : '#fecaca');
      doc.fillColor(statusColor).fontSize(8.5).font('Helvetica-Bold').text(statusText, badgeX, badgeY + 5, { width: badgeW, align: 'center' });

      // Divider Line
      y = Math.max(leftHeaderBottom, badgeY + 24) + 12;
      doc.moveTo(40, y).lineTo(555, y).strokeColor(borderColor).stroke();

      // 3. Billing & Transaction Cards (2 Balanced Columns)
      y += 12;

      // Card Left: Ditagihkan Kepada
      const cardH = 82;
      doc.roundedRect(40, y, 250, cardH, 8).fillAndStroke(lightBg, borderColor);
      doc.fillColor(mutedText).fontSize(7.5).font('Helvetica-Bold').text('DITAGIHKAN KEPADA', 52, y + 9);
      doc.fillColor(darkText).fontSize(11.5).font('Helvetica-Bold').text(customer.name || '-', 52, y + 21);

      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('ID Pelanggan:', 52, y + 37);
      doc.fillColor(darkText).fontSize(8).font('Helvetica-Bold').text(customer.customer_code || customer.pppoe_username || ('ID-' + customer.id), 112, y + 37);

      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('No. Telp / WA:', 52, y + 50);
      doc.fillColor(darkText).fontSize(8).font('Helvetica-Bold').text(customer.phone || '-', 112, y + 50);

      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('Alamat:', 52, y + 63);
      doc.fillColor(darkText).fontSize(8).font('Helvetica').text(customer.address || '-', 112, y + 63, { width: 168, lineBreak: false });

      // Card Right: Informasi Transaksi
      doc.roundedRect(305, y, 250, cardH, 8).fillAndStroke(lightBg, borderColor);
      doc.fillColor(mutedText).fontSize(7.5).font('Helvetica-Bold').text('INFORMASI TRANSAKSI', 317, y + 9);

      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('Periode Tagihan:', 317, y + 23);
      doc.fillColor(darkText).fontSize(8.5).font('Helvetica-Bold').text(periodStr, 395, y + 23);

      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('Tanggal Terbit:', 317, y + 37);
      doc.fillColor(darkText).fontSize(8).font('Helvetica-Bold').text(issueDateStr, 395, y + 37);

      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(isPaid ? 'Tanggal Bayar:' : 'Jatuh Tempo:', 317, y + 50);
      doc.fillColor(darkText).fontSize(8).font('Helvetica-Bold').text(paidDateStr, 395, y + 50);

      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('Metode Bayar:', 317, y + 63);
      doc.fillColor(isPaid ? '#059669' : primaryColor).fontSize(8).font('Helvetica-Bold').text(paymentMethodStr, 395, y + 63);

      // 4. Layanan Table (Hanya Layanan Nyata, Bukan Pajak)
      y += cardH + 16;
      doc.fillColor(mutedText).fontSize(8).font('Helvetica-Bold').text('RINCIAN LAYANAN', 40, y);
      y += 10;

      // Table Header
      const tblH = 22;
      doc.roundedRect(40, y, 515, tblH, 4).fill(lightBg);
      doc.rect(40, y, 515, tblH).strokeColor(borderColor).stroke();

      doc.fillColor(mutedText).fontSize(8).font('Helvetica-Bold');
      doc.text('#', 50, y + 6, { width: 25 });
      doc.text('Deskripsi Layanan', 75, y + 6, { width: 275 });
      doc.text('Periode', 355, y + 6, { width: 85 });
      doc.text('Jumlah', 445, y + 6, { width: 100, align: 'right' });

      y += tblH;

      // Row 1: Layanan Internet Produk Tunggal
      const row1H = 42;
      doc.rect(40, y, 515, row1H).strokeColor(borderColor).stroke();
      doc.fillColor(darkText).fontSize(9).font('Helvetica-Bold').text('01', 50, y + 14);

      doc.fillColor(darkText).fontSize(9.5).font('Helvetica-Bold').text(`Layanan Internet — ${pkgName}`, 75, y + 8);
      const subdesc = 'Langganan Internet Bulanan Unlimited';
      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(subdesc, 75, y + 23);

      doc.fillColor(darkText).fontSize(8.5).font('Helvetica').text(periodStr, 355, y + 14);
      doc.fillColor(darkText).fontSize(9.5).font('Helvetica-Bold').text(`Rp ${dpp.toLocaleString('id-ID')}`, 445, y + 14, { width: 100, align: 'right' });

      y += row1H;

      // Row Optional: Jika ada BHP / USO
      if (useUso && usoAmount > 0) {
        const usoRowH = 36;
        doc.rect(40, y, 515, usoRowH).strokeColor(borderColor).stroke();
        doc.fillColor(darkText).fontSize(9).font('Helvetica-Bold').text('02', 50, y + 11);
        doc.fillColor(darkText).fontSize(9.5).font('Helvetica-Bold').text(`Kontribusi BHP / USO ${usoRate}%`, 75, y + 7);
        doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('Universal Service Obligation sesuai regulasi telekomunikasi', 75, y + 21);
        doc.fillColor(darkText).fontSize(8.5).font('Helvetica').text(periodStr, 355, y + 11);
        doc.fillColor(darkText).fontSize(9.5).font('Helvetica-Bold').text(`Rp ${usoAmount.toLocaleString('id-ID')}`, 445, y + 11, { width: 100, align: 'right' });
        y += usoRowH;
      }

      // 5. Financial Summary (Right Aligned, Clean)
      y += 16;

      // Optional Notes (hanya jika ada invoice.notes khusus)
      if (invoice.notes && invoice.notes.trim() && !invoice.notes.toLowerCase().includes('terima kasih')) {
        doc.fillColor(mutedText).fontSize(7.5).font('Helvetica-Bold').text('CATATAN:', 40, y + 6);
        doc.fillColor(darkText).fontSize(8).font('Helvetica').text(invoice.notes.trim(), 40, y + 18, { width: 280 });
      }

      // Right Box: Totals Breakdown Card
      const rightX = 350;
      const rightW = 205;
      const hasUso = useUso && usoAmount > 0;
      const rightH = hasUso ? 92 : 76;
      doc.roundedRect(rightX, y, rightW, rightH, 8).fillAndStroke(lightBg, borderColor);

      // Subtotal line
      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text('Subtotal:', rightX + 12, y + 9);
      doc.fillColor(darkText).fontSize(8.5).font('Helvetica-Bold').text(`Rp ${dpp.toLocaleString('id-ID')}`, rightX + 90, y + 9, { width: 103, align: 'right' });

      // PPN line
      const ppnSummaryLabel = taxMode === 'included' ? `PPN ${ppnRate}% (Termasuk):` : `PPN ${ppnRate}%:`;
      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(ppnSummaryLabel, rightX + 12, y + 23);
      doc.fillColor(darkText).fontSize(8.5).font('Helvetica-Bold').text(`Rp ${ppnAmount.toLocaleString('id-ID')}`, rightX + 90, y + 23, { width: 103, align: 'right' });

      let currentTotalY = y + 37;
      if (hasUso) {
        doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(`BHP / USO ${usoRate}%:`, rightX + 12, currentTotalY);
        doc.fillColor(darkText).fontSize(8.5).font('Helvetica-Bold').text(`Rp ${usoAmount.toLocaleString('id-ID')}`, rightX + 90, currentTotalY, { width: 103, align: 'right' });
        currentTotalY += 14;
      }

      // Total Bayar Highlight Box
      const totalBoxH = 38;
      doc.roundedRect(rightX, currentTotalY, rightW, totalBoxH, 8).fill('#1e293b');
      doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica-Bold').text('TOTAL PEMBAYARAN', rightX + 12, currentTotalY + 13);
      doc.fillColor('#ffffff').fontSize(13.5).font('Helvetica-Bold').text(`Rp ${totalAmount.toLocaleString('id-ID')}`, rightX + 60, currentTotalY + 11, { width: 133, align: 'right' });

      // 6. Clean, Minimal Footer (Tanpa Catatan Pajak, Tanpa QR, Tanpa Stempel, Tanpa Manajer)
      y = currentTotalY + totalBoxH + 40;
      doc.moveTo(40, y).lineTo(555, y).strokeColor(borderColor).stroke();
      const footerY = y + 14;

      doc.fillColor(darkText).fontSize(9).font('Helvetica-Bold').text(companyName, 40, footerY);
      
      const compMeta = [companyAddress];
      if (companyPhone && companyPhone !== '-') compMeta.push(`Telp/WA: ${companyPhone}`);
      doc.fillColor(mutedText).fontSize(8).font('Helvetica').text(compMeta.join('  •  '), 40, footerY + 14, { width: 515 });

      const printNoticeY = doc.y + 3;
      doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text(`Faktur ini dicetak otomatis oleh sistem dan sah tanpa tanda tangan basah  •  ${new Date().toLocaleString('id-ID')}`, 40, printNoticeY, { width: 515 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateInvoicePdfBuffer
};
