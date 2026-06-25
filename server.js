/**
 * RAIKHSAPEDIA - server.js
 * Express Backend Server
 * Port: 3000 | Admin: localhost:3000/admin
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const multer   = require('multer');

// ============================================================
// MULTER — Upload QRIS Photo
// ============================================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, 'qris_' + Date.now() + ext);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Hanya file gambar yang diizinkan (jpg, png, webp, gif)'));
    },
});

const {
    cookieQueries,
    promoQueries,
    paymentQueries,
    getSetting,
    setSetting,
    createAdminSession,
    validateAdminSession,
    sessionQueries,
    generateNftoken,
    parseCookieMeta,
} = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
// CORS — di production, set env var FRONTEND_URL ke URL Vercel kamu
// Contoh: FRONTEND_URL=https://raikhsapedia.vercel.app
const allowedOrigins = process.env.FRONTEND_URL
    ? [process.env.FRONTEND_URL, 'http://localhost:3000']
    : true; // true = izinkan semua origin (development)

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend dari folder parent
app.use(express.static(path.join(__dirname, '..')));

// Serve admin panel
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Serve uploaded images
app.use('/uploads', express.static(UPLOADS_DIR));

// ============================================================
// ADMIN AUTH MIDDLEWARE
// ============================================================
function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (!validateAdminSession(token)) {
        return res.status(401).json({ error: 'Unauthorized. Login dulu.' });
    }
    // Bersihkan session expired
    sessionQueries.cleanup.run();
    next();
}

// ============================================================
// ==================== PUBLIC API ====================
// ============================================================

/**
 * POST /api/db-proxy
 * Ambil cookies aktif (dipanggil oleh frontend)
 */
app.post('/api/db-proxy', (req, res) => {
    try {
        const { query } = req.body;

        // Validasi request
        if (!query || query.table !== 'cookies' || query.action !== 'select') {
            return res.status(400).json({ error: 'Invalid query' });
        }

        const cookies = cookieQueries.getActive.all();

        // Map ke format yang diharapkan frontend
        const data = cookies.map(c => ({
            id:           c.id,
            cookie_data:  c.cookie_data,
            country_code: c.country_code,
            plan:         c.plan,
            status:       c.status,
        }));

        res.json({ data });
    } catch (err) {
        console.error('[db-proxy]', err.message);
        res.status(500).json({ error: 'Database error', data: [] });
    }
});

/**
 * POST /api/generate-nftoken
 * Generate token dari NetflixId (dipanggil frontend saat parse cookie)
 */
app.post('/api/generate-nftoken', async (req, res) => {
    try {
        const { netflixId } = req.body;
        if (!netflixId || typeof netflixId !== 'string' || netflixId.length < 5) {
            return res.status(400).json({ error: 'NetflixId tidak valid' });
        }

        const token = await generateNftoken(netflixId.trim());
        res.json({ token });
    } catch (err) {
        console.error('[generate-nftoken]', err.message);
        res.status(500).json({ error: err.message || 'Gagal generate token' });
    }
});

/**
 * GET /api/payment-config
 * Ambil konfigurasi harga
 */
app.get('/api/payment-config', (req, res) => {
    try {
        const amount     = parseInt(getSetting('price_regular')) || 15000;
        const indoAmount = parseInt(getSetting('price_indo'))    || 25000;
        res.json({ amount, indoAmount });
    } catch (err) {
        res.json({ amount: 15000, indoAmount: 25000 });
    }
});

// ============================================================
// CRC-16/CCITT-FALSE — standar checksum QRIS Indonesia
// ============================================================
function crc16ccitt(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * POST /api/create-qris
 * Buat order pembayaran + generate QRIS dummy
 * (Untuk integrasi payment gateway nyata, ganti bagian qris_string)
 */
app.post('/api/create-qris', (req, res) => {
    try {
        const { orderId, amount } = req.body;
        if (!orderId || !amount) {
            return res.status(400).json({ error: 'orderId dan amount diperlukan' });
        }

        // ⚡ QRIS Dummy — ganti dengan API payment gateway sungguhan
        // Contoh: Midtrans, Xendit, Duitku, dll.
        const qrisBase   = `00020101021226670016COM.NOBUBANK.WWW01189360050300000898720214${orderId}0303UMI51440014ID.CO.QRIS.WWW0215ID20200200702740303UMI5204481253033605802ID5920RAIKHSAPEDIA STORE6015JAKARTA SELATAN61051234062070703A016304`;
        const qris_string = qrisBase + crc16ccitt(qrisBase);

        // Ambil foto QRIS yang sudah diupload admin (jika ada)
        const qrisImageFile = getSetting('qris_image');
        const qrisImageUrl  = qrisImageFile ? '/uploads/' + qrisImageFile : null;

        // Simpan ke database
        paymentQueries.insert.run({
            order_id:    orderId,
            amount:      parseInt(amount),
            type:        req.body.type || 'regular',
            qris_string: qris_string,
            promo_code:  null,
        });

        res.json({
            qris_string,
            qris_image:    qrisImageUrl,
            total_payment: parseInt(amount),
            order_id:      orderId,
        });
    } catch (err) {
        console.error('[create-qris]', err.message);
        res.status(500).json({ error: 'Gagal membuat QRIS' });
    }
});

/**
 * GET /api/check-payment?order_id=...
 * Cek status pembayaran
 */
app.get('/api/check-payment', (req, res) => {
    try {
        const { order_id } = req.query;
        if (!order_id) return res.status(400).json({ error: 'order_id diperlukan' });

        const payment = paymentQueries.getByOrderId.get(order_id);
        if (!payment) return res.status(404).json({ error: 'Order tidak ditemukan' });

        res.json({ status: payment.status, order_id });
    } catch (err) {
        res.status(500).json({ error: 'Gagal cek pembayaran' });
    }
});

/**
 * POST /api/check-promo
 * Validasi kode promo
 */
app.post('/api/check-promo', (req, res) => {
    try {
        const { code, type } = req.body;
        if (!code) return res.status(400).json({ valid: false });

        const promo = promoQueries.getByCode.get(code.trim().toUpperCase());
        if (!promo) return res.json({ valid: false });

        // Cek expiry
        if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
            return res.json({ valid: false, reason: 'Promo sudah kadaluarsa' });
        }

        // Cek max uses
        if (promo.max_uses > 0 && promo.used_count >= promo.max_uses) {
            return res.json({ valid: false, reason: 'Promo sudah habis digunakan' });
        }

        // Cek applies_to
        if (promo.applies_to !== 'all' && promo.applies_to !== type) {
            return res.json({ valid: false, reason: 'Promo tidak berlaku untuk tipe ini' });
        }

        res.json({
            valid:       true,
            type:        promo.type,
            discount:    promo.discount,
            maxDiscount: promo.max_discount,
            code:        promo.code,
        });
    } catch (err) {
        console.error('[check-promo]', err.message);
        res.status(500).json({ valid: false });
    }
});

// ============================================================
// ==================== ADMIN API ====================
// ============================================================

/**
 * POST /api/admin/login
 * Admin login → dapat session token
 */
app.post('/api/admin/login', (req, res) => {
    try {
        const { password } = req.body;
        const correctPassword = getSetting('admin_password');

        if (!password || password !== correctPassword) {
            return res.status(401).json({ error: 'Password salah' });
        }

        const token = createAdminSession();
        res.json({ token, message: 'Login berhasil' });
    } catch (err) {
        res.status(500).json({ error: 'Login gagal' });
    }
});

/**
 * POST /api/admin/logout
 */
app.post('/api/admin/logout', requireAdmin, (req, res) => {
    const token = req.headers['x-admin-token'];
    sessionQueries.delete.run(token);
    res.json({ message: 'Logout berhasil' });
});

/**
 * GET /api/admin/stats
 * Dashboard statistik
 */
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    try {
        const totalCookies  = cookieQueries.count.get().total;
        const activeCookies = cookieQueries.countActive.get().total;
        const totalPayments = paymentQueries.countTotal.get().total;
        const paidPayments  = paymentQueries.countCompleted.get().total;
        const revenue       = paymentQueries.sumRevenue.get().total;
        const priceRegular  = parseInt(getSetting('price_regular')) || 3000;
        const priceIndo     = parseInt(getSetting('price_indo'))    || 10000;

        res.json({
            cookies:  { total: totalCookies, active: activeCookies },
            payments: { total: totalPayments, completed: paidPayments },
            revenue,
            prices:   { regular: priceRegular, indo: priceIndo },
        });
    } catch (err) {
        res.status(500).json({ error: 'Gagal ambil statistik' });
    }
});

/**
 * GET /api/admin/cookies
 * Lihat semua cookie (tanpa raw data)
 */
app.get('/api/admin/cookies', requireAdmin, (req, res) => {
    try {
        const cookies = cookieQueries.getAll.all();
        res.json({ cookies });
    } catch (err) {
        res.status(500).json({ error: 'Gagal ambil cookies' });
    }
});

/**
 * POST /api/admin/cookies
 * Tambah cookie baru (paste dari Cookie-Editor)
 */
app.post('/api/admin/cookies', requireAdmin, (req, res) => {
    try {
        const { cookie_data, country_code, notes } = req.body;

        if (!cookie_data || cookie_data.trim().length < 20) {
            return res.status(400).json({ error: 'Cookie data tidak boleh kosong' });
        }

        // Parse metadata dari cookie
        const meta = parseCookieMeta(cookie_data);

        const info = cookieQueries.insert.run({
            cookie_data:  cookie_data.trim(),
            country_code: (country_code || meta.country || 'ID').toUpperCase(),
            plan:         meta.plan    || 'Unknown',
            account_name: meta.name   || 'Unknown',
            next_billing: meta.billing || '--',
            status:       'green',
            notes:        notes || '',
        });

        res.json({
            id: info.lastInsertRowid,
            message: 'Cookie berhasil ditambahkan!',
            meta,
        });
    } catch (err) {
        console.error('[admin/cookies POST]', err.message);
        res.status(500).json({ error: 'Gagal menyimpan cookie: ' + err.message });
    }
});

/**
 * DELETE /api/admin/cookies/:id
 * Hapus cookie
 */
app.delete('/api/admin/cookies/:id', requireAdmin, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        cookieQueries.delete.run(id);
        res.json({ message: 'Cookie dihapus' });
    } catch (err) {
        res.status(500).json({ error: 'Gagal hapus cookie' });
    }
});

/**
 * PATCH /api/admin/cookies/:id/status
 * Toggle status cookie (green ↔ red)
 */
app.patch('/api/admin/cookies/:id/status', requireAdmin, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { status } = req.body;
        if (!['green', 'red', 'pending'].includes(status)) {
            return res.status(400).json({ error: 'Status tidak valid' });
        }
        cookieQueries.updateStatus.run(status, id);
        res.json({ message: 'Status diupdate', status });
    } catch (err) {
        res.status(500).json({ error: 'Gagal update status' });
    }
});

/**
 * GET /api/admin/payments
 * Lihat riwayat pembayaran
 */
app.get('/api/admin/payments', requireAdmin, (req, res) => {
    try {
        const payments = paymentQueries.getAll.all();
        res.json({ payments });
    } catch (err) {
        res.status(500).json({ error: 'Gagal ambil payments' });
    }
});

/**
 * PATCH /api/admin/payments/:order_id/confirm
 * Konfirmasi pembayaran manual
 */
app.patch('/api/admin/payments/:order_id/confirm', requireAdmin, (req, res) => {
    try {
        const { order_id } = req.params;
        paymentQueries.updateStatus.run('completed', 'completed', order_id);
        res.json({ message: 'Pembayaran dikonfirmasi', status: 'completed' });
    } catch (err) {
        res.status(500).json({ error: 'Gagal konfirmasi' });
    }
});

/**
 * PUT /api/admin/payments/:order_id
 * Edit data pembayaran (amount, type, status)
 */
app.put('/api/admin/payments/:order_id', requireAdmin, (req, res) => {
    try {
        const { order_id } = req.params;
        const { amount, type, status, notes } = req.body;
        paymentQueries.update.run({ amount, type, status, notes, order_id });
        res.json({ message: 'Pembayaran diupdate' });
    } catch (err) {
        console.error('[admin/payments PUT]', err.message);
        res.status(500).json({ error: 'Gagal update pembayaran: ' + err.message });
    }
});

/**
 * DELETE /api/admin/payments/:order_id
 * Hapus data pembayaran
 */
app.delete('/api/admin/payments/:order_id', requireAdmin, (req, res) => {
    try {
        const { order_id } = req.params;
        paymentQueries.delete.run(order_id);
        res.json({ message: 'Pembayaran dihapus' });
    } catch (err) {
        res.status(500).json({ error: 'Gagal hapus pembayaran' });
    }
});

/**
 * GET /api/admin/qris
 * Ambil info foto QRIS saat ini
 */
app.get('/api/admin/qris', requireAdmin, (req, res) => {
    try {
        const qrisFile = getSetting('qris_image');
        res.json({ qris_image: qrisFile || null });
    } catch (err) {
        res.status(500).json({ error: 'Gagal ambil info QRIS' });
    }
});

/**
 * GET /api/payment-info
 * Ambil foto QRIS untuk ditampilkan di frontend (publik)
 */
app.get('/api/payment-info', (req, res) => {
    try {
        const qrisFile = getSetting('qris_image');
        res.json({ qris_image: qrisFile || null });
    } catch (err) {
        res.json({ qris_image: null });
    }
});

/**
 * POST /api/admin/qris/upload
 * Upload foto QRIS baru — hapus foto lama otomatis
 */
app.post('/api/admin/qris/upload', requireAdmin, upload.single('qris'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'File gambar diperlukan' });
        }

        // Hapus foto lama jika ada
        const oldFile = getSetting('qris_image');
        if (oldFile) {
            const oldPath = path.join(UPLOADS_DIR, oldFile);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        // Simpan nama file baru ke settings
        setSetting('qris_image', req.file.filename);

        res.json({
            message: 'Foto QRIS berhasil diupload!',
            filename: req.file.filename,
            url: '/uploads/' + req.file.filename,
        });
    } catch (err) {
        console.error('[qris/upload]', err.message);
        res.status(500).json({ error: 'Gagal upload QRIS: ' + err.message });
    }
});

/**
 * DELETE /api/admin/qris
 * Hapus foto QRIS
 */
app.delete('/api/admin/qris', requireAdmin, (req, res) => {
    try {
        const qrisFile = getSetting('qris_image');
        if (qrisFile) {
            const filePath = path.join(UPLOADS_DIR, qrisFile);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            setSetting('qris_image', '');
        }
        res.json({ message: 'Foto QRIS dihapus' });
    } catch (err) {
        res.status(500).json({ error: 'Gagal hapus QRIS' });
    }
});

/**
 * GET /api/admin/promos
 * Lihat semua promo code
 */
app.get('/api/admin/promos', requireAdmin, (req, res) => {
    try {
        const promos = promoQueries.getAll.all();
        res.json({ promos });
    } catch (err) {
        res.status(500).json({ error: 'Gagal ambil promos' });
    }
});

/**
 * POST /api/admin/promos
 * Tambah promo code baru
 */
app.post('/api/admin/promos', requireAdmin, (req, res) => {
    try {
        const { code, type, discount, max_discount, max_uses, applies_to, expires_at } = req.body;

        if (!code || !discount) {
            return res.status(400).json({ error: 'Code dan discount diperlukan' });
        }

        const info = promoQueries.insert.run({
            code:         code.trim().toUpperCase(),
            type:         type || 'percent',
            discount:     parseInt(discount) || 0,
            max_discount: parseInt(max_discount) || 0,
            max_uses:     parseInt(max_uses) || 0,
            applies_to:   applies_to || 'all',
            expires_at:   expires_at || null,
        });

        res.json({ id: info.lastInsertRowid, message: 'Promo berhasil ditambahkan!' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Kode promo sudah ada' });
        }
        res.status(500).json({ error: 'Gagal simpan promo: ' + err.message });
    }
});

/**
 * DELETE /api/admin/promos/:id
 */
app.delete('/api/admin/promos/:id', requireAdmin, (req, res) => {
    try {
        promoQueries.delete.run(parseInt(req.params.id));
        res.json({ message: 'Promo dihapus' });
    } catch (err) {
        res.status(500).json({ error: 'Gagal hapus promo' });
    }
});

/**
 * GET/POST /api/admin/settings
 * Kelola pengaturan (harga, password, dll)
 */
app.get('/api/admin/settings', requireAdmin, (req, res) => {
    try {
        const settings = {};
        const rows = require('./db').settingQueries.getAll.all();
        for (const r of rows) {
            // Jangan tampilkan password dalam plain text
            settings[r.key] = r.key === 'admin_password' ? '***' : r.value;
        }
        res.json({ settings });
    } catch (err) {
        res.status(500).json({ error: 'Gagal ambil settings' });
    }
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
    try {
        const { key, value } = req.body;
        const allowed = ['price_regular', 'price_indo', 'admin_password', 'site_name', 'qris_image'];
        if (!allowed.includes(key)) {
            return res.status(400).json({ error: 'Setting tidak diizinkan' });
        }
        setSetting(key, value);
        res.json({ message: 'Setting disimpan' });
    } catch (err) {
        res.status(500).json({ error: 'Gagal simpan setting' });
    }
});

// ============================================================
// ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// START SERVER (Graceful — Railway-compatible)
// ============================================================
const server = app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║     RAIKHSAPEDIA BACKEND SERVER      ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  🌐  Port    : ${PORT}                    ║`);
    console.log(`║  🛡️  Admin   : /admin                 ║`);
    console.log('║  📦  Database: JSON Files             ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
    console.log('  Default admin password: raikhs123');
    console.log('  (Ganti di Admin → Settings)');
    console.log('');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} sedang digunakan. Menunggu 2 detik dan mencoba lagi...`);
        setTimeout(() => {
            server.close();
            server.listen(PORT);
        }, 2000);
    } else {
        console.error('❌ Server error:', err.message);
        process.exit(1);
    }
});

// Graceful shutdown — penting untuk Railway agar tidak EADDRINUSE saat restart
function gracefulShutdown(signal) {
    console.log(`\n⚡ ${signal} diterima. Menutup server...`);
    server.close(() => {
        console.log('✅ Server ditutup dengan bersih.');
        process.exit(0);
    });
    // Force exit jika terlalu lama
    setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

