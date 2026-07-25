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

// إنشاء الجدول بالحقول الجديدة
async function initDb() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_name TEXT,
            phone TEXT,
            appointment_date TEXT,
            diagnosis TEXT,
            notes TEXT,
            prescription_text TEXT,
            ecg_url TEXT,
            xray_url TEXT,
            prescription_url TEXT,
            echo_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
}
initDb().catch(console.error);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

const upload = multer({ storage: multer.memoryStorage() });

// إعداد رفع الحقول المتعددة
const cpUpload = upload.fields([
    { name: 'ecg_file', maxCount: 1 },
    { name: 'xray_file', maxCount: 1 },
    { name: 'prescription_file', maxCount: 1 },
    { name: 'echo_file', maxCount: 1 }
]);

// رفع الملفات لـ Cloudinary
async function uploadToCloudinary(file, folderName) {
    if (!file) return null;
    const b64 = Buffer.from(file.buffer).toString("base64");
    let dataURI = "data:" + file.mimetype + ";base64," + b64;
    const cldRes = await cloudinary.uploader.upload(dataURI, {
        resource_type: "auto",
        folder: folderName
    });
    return cldRes.secure_url;
}

// 1. تسجيل حالة جديدة
app.post('/api/bookings', cpUpload, async (req, res) => {
    try {
        const { patient_name, phone, appointment_date, diagnosis, notes, prescription_text } = req.body;

        const ecg_url = req.files && req.files['ecg_file'] ? await uploadToCloudinary(req.files['ecg_file'][0], 'clinic_ecg') : null;
        const xray_url = req.files && req.files['xray_file'] ? await uploadToCloudinary(req.files['xray_file'][0], 'clinic_xray') : null;
        const prescription_url = req.files && req.files['prescription_file'] ? await uploadToCloudinary(req.files['prescription_file'][0], 'clinic_prescriptions') : null;
        const echo_url = req.files && req.files['echo_file'] ? await uploadToCloudinary(req.files['echo_file'][0], 'clinic_echo') : null;

        await db.execute({
            sql: `INSERT INTO bookings (patient_name, phone, appointment_date, diagnosis, notes, prescription_text, ecg_url, xray_url, prescription_url, echo_url) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                patient_name || null,
                phone || null,
                appointment_date || null,
                diagnosis || null,
                notes || null,
                prescription_text || null,
                ecg_url,
                xray_url,
                prescription_url,
                echo_url
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
                  WHERE patient_name LIKE ? OR phone LIKE ? OR diagnosis LIKE ? OR prescription_text LIKE ?
                  ORDER BY id DESC LIMIT 50`,
            args: [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`]
        });

        res.json(result.rows);
    } catch (error) {
        console.error('Error searching bookings:', error);
        res.status(500).json({ success: false, message: 'حدث خطأ في البحث' });
    }
});

// 3. تنزيل النسخة الاحتياطية (ZIP) مجمعة
app.get('/api/admin/backup', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM bookings");
        const rows = result.rows;

        res.attachment('clinic_backup.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        archive.append(JSON.stringify(rows, null, 2), { name: 'database_export.json' });

        const fileTypes = ['ecg_url', 'xray_url', 'prescription_url', 'echo_url'];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            for (const type of fileTypes) {
                if (row[type]) {
                    try {
                        const response = await axios.get(row[type], { responseType: 'arraybuffer' });
                        const urlParts = row[type].split('/');
                        const fileName = `attachments/${type.replace('_url','')}_patient_${row.id}_${urlParts[urlParts.length - 1]}`;
                        archive.append(Buffer.from(response.data), { name: fileName });
                    } catch (err) {
                        console.error('Error downloading attachment:', row[type]);
                    }
                }
            }
        }

        await archive.finalize();
    } catch (error) {
        console.error('Error generating backup:', error);
        res.status(500).send('حدث خطأ أثناء إعداد النسخة الاحتياطية');
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
