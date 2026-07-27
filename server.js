require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client/http');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد بيانات الأمان وتسجيل الدخول
const JWT_SECRET = process.env.JWT_SECRET || 'clinic_secret_key_heart_1471155';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'moclinc147';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Drheart1155##';

// إعداد Cloudinary بالطريقة الرسمية
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// التخزين في الذاكرة المؤقتة (Memory Storage) لتفادي أخطاء التوقيع (Invalid Signature)
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10 Megabytes
});

// دالة مساعدة لرفع الملفات المباشر لـ Cloudinary بدون مشاكل Signature
const uploadToCloudinary = (fileBuffer) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: 'clinic_uploads', resource_type: 'auto' },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url);
            }
        );
        stream.end(fileBuffer);
    });
};

// معالجة رابط قاعدة البيانات Turso
let rawUrl = (process.env.TURSO_DATABASE_URL || "").trim().replace(/[\r\n]+/g, "");
if (rawUrl.startsWith("libsql://")) {
    rawUrl = rawUrl.replace("libsql://", "https://");
} else if (rawUrl !== "" && !rawUrl.startsWith("https://")) {
    rawUrl = "https://" + rawUrl;
}

const db = createClient({
    url: rawUrl,
    authToken: (process.env.TURSO_AUTH_TOKEN || "").trim()
});

// تهيئة قاعدة البيانات
async function initDb() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS patients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                age INTEGER,
                phone TEXT NOT NULL
            );
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS visits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                visit_date TEXT,
                visit_type TEXT,
                diagnosis TEXT,
                medication_type TEXT,
                medication_text TEXT,
                medication_file TEXT,
                has_ecg TEXT DEFAULT 'لا',
                ecg_file TEXT,
                has_rays TEXT DEFAULT 'لا',
                rays_file TEXT,
                has_other_rays TEXT DEFAULT 'لا',
                other_rays_file TEXT,
                has_labs TEXT DEFAULT 'لا',
                labs_file TEXT,
                FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
            );
        `);
        console.log("✅ تم الاتصال بقاعدة بيانات Turso وتجهيز الجداول بنجاح.");
    } catch (err) {
        console.error("❌ خطأ قاعدة البيانات:", err.message || err);
    }
}
initDb();

// 🔒 نظام تسجيل الدخول
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '730d' });
        return res.json({ success: true, token });
    }
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

// Middleware للحماية
const requireAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'غير مصرح لك بالوصول.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'جلسة الدخول انتهت.' });
        req.user = user;
        next();
    });
};

const cpUpload = upload.fields([
    { name: 'medicationFile', maxCount: 1 },
    { name: 'ecgFile', maxCount: 1 },
    { name: 'raysFile', maxCount: 1 },
    { name: 'otherRaysFile', maxCount: 1 },
    { name: 'labsFile', maxCount: 1 }
]);

// حفظ / تعديل زيارة ومريض
app.post('/api/visit', requireAuth, (req, res, next) => {
    cpUpload(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        next();
    });
}, async (req, res) => {
    try {
        const {
            visitId, patientId: passedPatientId, name, age, phone,
            visitDate, visitType, customVisitType, diagnosis, customDiagnosis,
            medicationType, medicationText, hasEcg, hasRays, hasOtherRays, hasLabs
        } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: 'اسم المريض ورقم الهاتف بيانات إجبارية' });
        }

        const cleanPhone = phone.trim();
        const cleanName = name.trim();
        const parsedAge = age ? parseInt(age) : null;
        
        const finalVisitType = (visitType === 'آخر' && customVisitType) ? customVisitType.trim() : (visitType || 'كشف');
        const finalDiagnosis = (diagnosis === 'آخر' && customDiagnosis) ? customDiagnosis.trim() : diagnosis;

        let patientId = passedPatientId ? parseInt(passedPatientId) : null;

        if (patientId) {
            await db.execute({
                sql: 'UPDATE patients SET name = ?, age = ?, phone = ? WHERE id = ?',
                args: [cleanName, parsedAge, cleanPhone, patientId]
            });
        } else {
            let insertRes = await db.execute({
                sql: 'INSERT INTO patients (name, age, phone) VALUES (?, ?, ?)',
                args: [cleanName, parsedAge, cleanPhone]
            });
            patientId = Number(insertRes.lastInsertRowid);
        }

        // رفع الملفات لـ Cloudinary إن وجدت
        let medFile = null, ecgFile = null, raysFile = null, otherRaysFile = null, labsFile = null;

        if (req.files?.['medicationFile']?.[0]) {
            medFile = await uploadToCloudinary(req.files['medicationFile'][0].buffer);
        }
        if (req.files?.['ecgFile']?.[0]) {
            ecgFile = await uploadToCloudinary(req.files['ecgFile'][0].buffer);
        }
        if (req.files?.['raysFile']?.[0]) {
            raysFile = await uploadToCloudinary(req.files['raysFile'][0].buffer);
        }
        if (req.files?.['otherRaysFile']?.[0]) {
            otherRaysFile = await uploadToCloudinary(req.files['otherRaysFile'][0].buffer);
        }
        if (req.files?.['labsFile']?.[0]) {
            labsFile = await uploadToCloudinary(req.files['labsFile'][0].buffer);
        }

        if (visitId && visitId !== '') {
            let currentVisitRes = await db.execute({
                sql: 'SELECT * FROM visits WHERE id = ?',
                args: [visitId]
            });

            if (currentVisitRes.rows.length > 0) {
                const currentVisit = currentVisitRes.rows[0];
                await db.execute({
                    sql: `
                        UPDATE visits SET 
                            visit_date = ?, visit_type = ?, diagnosis = ?, medication_type = ?, medication_text = ?,
                            medication_file = ?, has_ecg = ?, ecg_file = ?, has_rays = ?, rays_file = ?,
                            has_other_rays = ?, other_rays_file = ?, has_labs = ?, labs_file = ?
                        WHERE id = ?
                    `,
                    args: [
                        visitDate, finalVisitType, finalDiagnosis || '', medicationType || 'text', medicationText || '',
                        medFile || currentVisit.medication_file, hasEcg || 'لا', ecgFile || currentVisit.ecg_file,
                        hasRays || 'لا', raysFile || currentVisit.rays_file,
                        hasOtherRays || 'لا', otherRaysFile || currentVisit.other_rays_file,
                        hasLabs || 'لا', labsFile || currentVisit.labs_file, visitId
                    ]
                });
            }
        } else {
            await db.execute({
                sql: `
                    INSERT INTO visits (patient_id, visit_date, visit_type, diagnosis, medication_type, medication_text, medication_file, has_ecg, ecg_file, has_rays, rays_file, has_other_rays, other_rays_file, has_labs, labs_file)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                args: [patientId, visitDate, finalVisitType, finalDiagnosis || '', medicationType || 'text', medicationText || '', medFile, hasEcg || 'لا', ecgFile, hasRays || 'لا', raysFile, hasOtherRays || 'لا', otherRaysFile, hasLabs || 'لا', labsFile]
            });
        }

        res.json({ success: true, message: 'تم حفظ البيانات بنجاح' });
    } catch (error) {
        console.error("Save Error:", error);
        res.status(400).json({ error: error.message || 'حدث خطأ أثناء تنفيذ العملية' });
    }
});

// جلب قائمة المرضى
app.get('/api/patients', requireAuth, async (req, res) => {
    try {
        const query = req.query.q ? `%${req.query.q.trim()}%` : '%';
        const result = await db.execute({
            sql: `
                SELECT p.id, p.name, p.age, p.phone, 
                       v.id as visit_id, v.visit_date, v.visit_type, v.diagnosis, v.medication_type, 
                       v.medication_text, v.medication_file, v.has_ecg, v.ecg_file, v.has_rays, v.rays_file,
                       v.has_other_rays, v.other_rays_file, v.has_labs, v.labs_file
                FROM patients p
                LEFT JOIN visits v ON p.id = v.patient_id
                WHERE p.name LIKE ? OR p.phone LIKE ?
                ORDER BY p.id DESC, v.visit_date DESC
            `,
            args: [query, query]
        });

        const patientsMap = {};
        result.rows.forEach(row => {
            if (!patientsMap[row.id]) {
                patientsMap[row.id] = { id: row.id, name: row.name, age: row.age, phone: row.phone, visits: [] };
            }
            if (row.visit_id) {
                patientsMap[row.id].visits.push({
                    id: row.visit_id, visit_date: row.visit_date, visit_type: row.visit_type, diagnosis: row.diagnosis,
                    medication_type: row.medication_type, medication_text: row.medication_text,
                    medication_file: row.medication_file, has_ecg: row.has_ecg, ecg_file: row.ecg_file,
                    has_rays: row.has_rays, rays_file: row.rays_file,
                    has_other_rays: row.has_other_rays, other_rays_file: row.other_rays_file,
                    has_labs: row.has_labs, labs_file: row.labs_file
                });
            }
        });

        res.json(Object.values(patientsMap));
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: 'خطأ في جلب بيانات المرضى' });
    }
});

// حذف مريض
app.delete('/api/patient/:id', requireAuth, async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM patients WHERE id = ?', args: [req.params.id] });
        res.json({ success: true, message: 'تم حذف سجل المريض بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء عملية الحذف' });
    }
});

// حذف زيارة
app.delete('/api/visit/:id', requireAuth, async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM visits WHERE id = ?', args: [req.params.id] });
        res.json({ success: true, message: 'تم حذف الزيارة بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء حذف الزيارة' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ سيرفر العيادة يعمل بنجاح ومؤمن على البورت: ${PORT}`);
});
