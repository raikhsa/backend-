/**
 * RAIKHSAPEDIA - db.js
 * Pure JSON File Database — tidak perlu Visual Studio / native compilation
 * Data disimpan di folder: backend/data/
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ============================================================
// DATA DIRECTORY
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// JSON DATABASE ENGINE
// ============================================================
class JsonDB {
    constructor(filename) {
        this.file = path.join(DATA_DIR, filename + '.json');
        this._cache = null;
    }

    // Baca data (pakai cache)
    read() {
        if (this._cache !== null) return this._cache;
        try {
            this._cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch {
            this._cache = [];
        }
        return this._cache;
    }

    // Tulis data ke file
    write(data) {
        this._cache = data;
        fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    }

    // Auto-increment ID
    nextId() {
        const data = this.read();
        return data.length > 0 ? Math.max(...data.map(r => r.id || 0)) + 1 : 1;
    }
}

// ============================================================
// KV STORE (untuk settings)
// ============================================================
class KvStore {
    constructor(filename) {
        this.file = path.join(DATA_DIR, filename + '.json');
    }

    read() {
        try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
        catch { return {}; }
    }

    write(data) {
        fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    }

    get(key) { return this.read()[key] ?? null; }

    set(key, value) {
        const data = this.read();
        data[key] = value;
        this.write(data);
    }

    getAll() { return this.read(); }
}

// ============================================================
// INISIALISASI DATABASE
// ============================================================
const cookiesDB  = new JsonDB('cookies');
const promosDB   = new JsonDB('promos');
const paymentsDB = new JsonDB('payments');
const sessionsDB = new JsonDB('sessions');
const settingsKV = new KvStore('settings');

// Default settings
const DEFAULTS = {
    price_regular:  '3000',
    price_indo:     '10000',
    admin_password: 'raikhs123',
    site_name:      'Raikhsapedia',
};

function initDatabase() {
    // Pastikan semua file ada
    [cookiesDB, promosDB, paymentsDB, sessionsDB].forEach(db => {
        if (!fs.existsSync(db.file)) db.write([]);
    });

    // Default settings
    const existing = settingsKV.getAll();
    const merged = { ...DEFAULTS, ...existing };
    settingsKV.write(merged);

    console.log('✅ Database (JSON) initialized di:', DATA_DIR);
}

// ============================================================
// SETTINGS HELPERS
// ============================================================
function getSetting(key) { return settingsKV.get(key); }
function setSetting(key, value) { settingsKV.set(key, String(value)); }

// Expose settingQueries.getAll untuk server.js
const settingQueries = {
    getAll: { all: () => Object.entries(settingsKV.getAll()).map(([key, value]) => ({ key, value })) }
};

// ============================================================
// COOKIE HELPERS
// ============================================================
const cookieQueries = {
    getAll: {
        all: () => cookiesDB.read().sort((a, b) => new Date(b.added_at) - new Date(a.added_at))
            .map(c => ({ ...c, cookie_preview: String(c.cookie_data || '').substring(0, 80) }))
    },

    getActive: {
        all: () => cookiesDB.read()
            .filter(c => c.status === 'green')
            .sort((a, b) => (a.use_count || 0) - (b.use_count || 0))
    },

    getById: { get: (id) => cookiesDB.read().find(c => c.id === id) || null },

    insert: {
        run: (data) => {
            const rows = cookiesDB.read();
            const newId = cookiesDB.nextId();
            const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }).replace(/\//g, '-');
            rows.push({ id: newId, ...data, use_count: 0, added_at: now, last_checked: now });
            cookiesDB.write(rows);
            return { lastInsertRowid: newId };
        }
    },

    updateStatus: {
        run: (status, id) => {
            const rows = cookiesDB.read();
            const idx = rows.findIndex(c => c.id === id);
            if (idx !== -1) { rows[idx].status = status; cookiesDB.write(rows); }
        }
    },

    incrementUse: {
        run: (id) => {
            const rows = cookiesDB.read();
            const idx = rows.findIndex(c => c.id === id);
            if (idx !== -1) { rows[idx].use_count = (rows[idx].use_count || 0) + 1; cookiesDB.write(rows); }
        }
    },

    delete: {
        run: (id) => {
            cookiesDB._cache = null;
            cookiesDB.write(cookiesDB.read().filter(c => c.id !== id));
        }
    },

    count:       { get: () => ({ total: cookiesDB.read().length }) },
    countActive: { get: () => ({ total: cookiesDB.read().filter(c => c.status === 'green').length }) },
};

// ============================================================
// PROMO HELPERS
// ============================================================
const promoQueries = {
    getAll: { all: () => promosDB.read().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) },

    getByCode: {
        get: (code) => promosDB.read().find(p =>
            p.code?.toUpperCase() === code?.toUpperCase() && p.active === 1
        ) || null
    },

    insert: {
        run: (data) => {
            const rows = promosDB.read();
            // Cek unique
            if (rows.find(p => p.code?.toUpperCase() === data.code?.toUpperCase())) {
                throw new Error('UNIQUE constraint failed: promo_codes.code');
            }
            const newId = promosDB.nextId();
            const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }).replace(/\//g, '-');
            rows.push({ id: newId, ...data, used_count: 0, active: 1, created_at: now });
            promosDB.write(rows);
            return { lastInsertRowid: newId };
        }
    },

    incrementUse: {
        run: (id) => {
            const rows = promosDB.read();
            const idx = rows.findIndex(p => p.id === id);
            if (idx !== -1) { rows[idx].used_count = (rows[idx].used_count || 0) + 1; promosDB.write(rows); }
        }
    },

    toggleActive: {
        run: (id) => {
            const rows = promosDB.read();
            const idx = rows.findIndex(p => p.id === id);
            if (idx !== -1) { rows[idx].active = rows[idx].active ? 0 : 1; promosDB.write(rows); }
        }
    },

    delete: {
        run: (id) => {
            promosDB._cache = null;
            promosDB.write(promosDB.read().filter(p => p.id !== id));
        }
    },
};

// ============================================================
// PAYMENT HELPERS
// ============================================================
const paymentQueries = {
    getAll: {
        all: () => paymentsDB.read()
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 50)
    },

    getByOrderId: { get: (orderId) => paymentsDB.read().find(p => p.order_id === orderId) || null },

    insert: {
        run: (data) => {
            const rows = paymentsDB.read();
            const newId = paymentsDB.nextId();
            const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }).replace(/\//g, '-');
            rows.push({ id: newId, ...data, status: 'pending', created_at: now, paid_at: null });
            paymentsDB.write(rows);
            return { lastInsertRowid: newId };
        }
    },

    updateStatus: {
        run: (status, _forPaidAt, orderId) => {
            const rows = paymentsDB.read();
            const idx = rows.findIndex(p => p.order_id === orderId);
            if (idx !== -1) {
                rows[idx].status = status;
                if (status === 'completed') {
                    rows[idx].paid_at = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }).replace(/\//g, '-');
                }
                paymentsDB.write(rows);
            }
        }
    },

    update: {
        run: ({ amount, type, status, notes, order_id }) => {
            const rows = paymentsDB.read();
            const idx = rows.findIndex(p => p.order_id === order_id);
            if (idx === -1) throw new Error('Order tidak ditemukan');
            if (amount !== undefined && amount !== null && amount !== '') rows[idx].amount = parseInt(amount);
            if (type)   rows[idx].type   = type;
            if (status) {
                rows[idx].status = status;
                if (status === 'completed' && !rows[idx].paid_at) {
                    rows[idx].paid_at = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }).replace(/\//g, '-');
                }
            }
            if (notes !== undefined) rows[idx].notes = notes;
            paymentsDB.write(rows);
        }
    },

    delete: {
        run: (orderId) => {
            paymentsDB._cache = null;
            paymentsDB.write(paymentsDB.read().filter(p => p.order_id !== orderId));
        }
    },

    countTotal:     { get: () => ({ total: paymentsDB.read().length }) },
    countCompleted: { get: () => ({ total: paymentsDB.read().filter(p => p.status === 'completed').length }) },
    sumRevenue:     { get: () => ({ total: paymentsDB.read().filter(p => p.status === 'completed').reduce((s, p) => s + (p.amount || 0), 0) }) },
};

// ============================================================
// ADMIN SESSION HELPERS
// ============================================================
const sessionQueries = {
    create: {
        run: (token) => {
            const rows = sessionsDB.read();
            const exp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
            rows.push({ token, created_at: new Date().toISOString(), expires_at: exp });
            sessionsDB.write(rows);
        }
    },
    validate: {
        get: (token) => {
            const now = new Date();
            return sessionsDB.read().find(s => s.token === token && new Date(s.expires_at) > now) || null;
        }
    },
    delete: {
        run: (token) => {
            sessionsDB._cache = null;
            sessionsDB.write(sessionsDB.read().filter(s => s.token !== token));
        }
    },
    cleanup: {
        run: () => {
            const now = new Date();
            sessionsDB._cache = null;
            sessionsDB.write(sessionsDB.read().filter(s => new Date(s.expires_at) > now));
        }
    },
};

function createAdminSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessionQueries.create.run(token);
    return token;
}

function validateAdminSession(token) {
    if (!token) return false;
    return !!sessionQueries.validate.get(token);
}

// ============================================================
// NFTOKEN GENERATOR
// ============================================================
const SECRET = 'raikhsapedia-nftoken-secret-2026';

function generateNftoken(netflixId) {
    const payload = {
        id:  netflixId,
        ts:  Date.now(),
        exp: Date.now() + (6 * 60 * 60 * 1000), // 6 jam
    };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig  = crypto.createHmac('sha256', SECRET).update(data).digest('base64url').substring(0, 16);
    return data + '.' + sig;
}

function decodeNftoken(token) {
    try {
        const [data, sig] = token.split('.');
        const expectedSig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url').substring(0, 16);
        if (sig !== expectedSig) return null;
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
        if (Date.now() > payload.exp) return null;
        return payload;
    } catch { return null; }
}

// ============================================================
// PARSE COOKIE META (Server-side)
// ============================================================
function parseCookieMeta(rawText) {
    const meta = { name: 'Unknown', plan: 'Unknown', country: '--', billing: '--', netflixId: null };
    const lines = rawText.split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();

        const nameMatch = line.match(/(?:name|profil|profiles?)\s*[:=]\s*(.*)/i);
        if (nameMatch && meta.name === 'Unknown') meta.name = nameMatch[1].trim().replace(/^-+|-+$/g, '').trim();

        const planMatch = line.match(/plan\s*[:=]\s*(.*)/i);
        if (planMatch && meta.plan === 'Unknown') meta.plan = planMatch[1].trim().replace(/^-+|-+$/g, '').trim();

        const countryMatch = line.match(/(?:country|region)\s*[:=]\s*(.*)/i);
        if (countryMatch) meta.country = countryMatch[1].trim().replace(/^-+|-+$/g, '').trim();

        const billingMatch = line.match(/(?:next billing|billing date|expires?)\s*[:=]\s*(.*)/i);
        if (billingMatch && meta.billing === '--') meta.billing = billingMatch[1].trim().replace(/^-+|-+$/g, '').trim();

        if (line.includes('.netflix.com') && line.split('\t').length >= 6) {
            if (line.includes('NetflixId') && !line.includes('SecureNetflixId')) {
                meta.netflixId = line.split('\t').slice(-1)[0].trim();
            }
        }
    }
    return meta;
}

// ============================================================
// INIT
// ============================================================
initDatabase();

module.exports = {
    cookieQueries,
    promoQueries,
    paymentQueries,
    settingQueries,
    sessionQueries,
    getSetting,
    setSetting,
    createAdminSession,
    validateAdminSession,
    generateNftoken,
    decodeNftoken,
    parseCookieMeta,
};
