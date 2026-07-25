require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client/http');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2;
const archiver = require('archiver');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// اتصال بنك البيانات Turso SQLite
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN
});

// إنشاء الجدول إذا لم يكن موجوداً
async function initDb() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_name TEXT,
            phone TEXT,
            appointment_date TEXT,
            diagnosis TEXT,
            notes TEXT,
            attachment_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
}
initDb().catch(console.error);

// إعدادات الأمن والوسائط
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

const upload = multer({ storage: multer.memoryStorage() });

// 1. إضافة حجز جديد
app.post('/api/bookings', upload.single('attachment'), async (req, res) => {
    try {
        const { patient_name, phone, appointment_date, diagnosis, notes } = req.body;
        let attachment_url = null;

        if (req.file) {
            const b64 = Buffer.from(req.file.buffer).toString("base64");
            let dataURI = "data:" + req.file.mimetype + ";base64," + b64;
            const cldRes = await cloudinary.uploader.upload(dataURI, {
                resource_type: "auto",
                folder: "clinic_attachments"
            });
            attachment_url = cldRes.secure_url;
        }

        await db.execute({
            sql: `INSERT INTO bookings (patient_name, phone, appointment_date, diagnosis, notes, attachment_url) 
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [
                patient_name || null,
                phone || null,
                appointment_date || null,
                diagnosis || null,
                notes || null,
                attachment_url
            ]
        });

        res.json({ success: true, message: 'تم حفظ البيانات بنجاح' });
    } catch (error) {
        console.error('Error adding booking:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ في السيرفر' });
    }
});

// 2. البحث عن المواعيد والبيانات
app.get('/api/bookings/search', async (req, res) => {
    try {
        const query = req.query.q || '';
        const result = await db.execute({
            sql: `SELECT * FROM bookings 
                  WHERE patient_name LIKE ? OR phone LIKE ? OR diagnosis LIKE ?
                  ORDER BY id DESC LIMIT 50`,
            args: [`%${query}%`, `%${query}%`, `%${query}%`]
        });

        res.json(result.rows);
    } catch (error) {
        console.error('Error searching bookings:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ في البحث' });
    }
});

// 3. تنزيل النسخة الاحتياطية (ZIP)
app.get('/api/admin/backup', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM bookings");
        const rows = result.rows;

        res.attachment('clinic_backup.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        // إضافة الملف النصي للبيانات
        archive.append(JSON.stringify(rows, null, 2), { name: 'database_export.json' });

        // إضافة المرفقات
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.attachment_url) {
                try {
                    const response = await axios.get(row.attachment_url, { responseType: 'arraybuffer' });
                    const urlParts = row.attachment_url.split('/');
                    const fileName = `attachments/patient_${row.id}_${urlParts[urlParts.length - 1]}`;
                    archive.append(Buffer.from(response.data), { name: fileName });
                } catch (err) {
                    console.error('Error downloading attachment:', row.attachment_url);
                }
            }
        }

        await archive.finalize();
    } catch (error) {
        console.error('Error generating backup:', error);
        res.status(500).send('حدث خطأ أثناء إعداد النسخة الاحتياطية');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
