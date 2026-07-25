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

// الأمان والـ Middlewares
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// تحديد معدل الطلبات لحماية السيرفر
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'تم تجاوز حد الطلبات المسموح به، يرجى المحاولة لاحقاً.' }
});
app.use('/api/', limiter);

// تخزين مؤقت للملفات في الذاكرة لفحصها قبل الرفع
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // الحد الأقصى 10 ميجابايت للملف
});

// تجهيز رابط Turso DB
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

// إنشاء الجداول
async function initDb() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS patients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                age INTEGER,
                phone TEXT UNIQUE NOT NULL
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

// رفع دالة مساعدة لرفع الملفات إلى Cloudinary
async function uploadToCloudinary(fileBuffer, folder = 'clinic_uploads') {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: folder, resource_type: 'auto' },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url);
            }
        );
        stream.end(fileBuffer);
    });
}

// تعريف الحقول المسموح بها في الرفع
const cpUpload = upload.fields([
    { name: 'medicationImage', maxCount: 1 },
    { name: 'ecgFiles', maxCount: 1 },
    { name: 'echoFiles', maxCount: 1 },
    { name: 'otherFiles', maxCount: 1 },
    { name: 'labFiles', maxCount: 1 }
]);

// 1. حفظ / تعديل زيارة ومريض
app.post('/api/visit', cpUpload, async (req, res) => {
    try {
        const {
            visitId, patientId: passedPatientId, name, age, phone,
            visitDate, visitType, customVisitType, diagnosis, customDiagnosis,
            medicationType, medicationText
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

        // إدارة المريض
        if (patientId) {
            await db.execute({
                sql: 'UPDATE patients SET name = ?, age = ?, phone = ? WHERE id = ?',
                args: [cleanName, parsedAge, cleanPhone, patientId]
            });
        } else {
            let existingPatientRes = await db.execute({
                sql: 'SELECT id FROM patients WHERE phone = ?',
                args: [cleanPhone]
            });

            if (existingPatientRes.rows.length > 0) {
                patientId = existingPatientRes.rows[0].id;
                await db.execute({
                    sql: 'UPDATE patients SET name = ?, age = ? WHERE id = ?',
                    args: [cleanName, parsedAge, patientId]
                });
            } else {
                let insertRes = await db.execute({
                    sql: 'INSERT INTO patients (name, age, phone) VALUES (?, ?, ?)',
                    args: [cleanName, parsedAge, cleanPhone]
                });
                patientId = Number(insertRes.lastInsertRowid);
            }
        }

        // رفع الملفات لـ Cloudinary فقط بعد التأكد من صحة البيانات
        const files = req.files || {};
        const medFile = files['medicationImage'] ? await uploadToCloudinary(files['medicationImage'][0].buffer) : null;
        const ecgFile = files['ecgFiles'] ? await uploadToCloudinary(files['ecgFiles'][0].buffer) : null;
        const echoFile = files['echoFiles'] ? await uploadToCloudinary(files['echoFiles'][0].buffer) : null;
        const otherFile = files['otherFiles'] ? await uploadToCloudinary(files['otherFiles'][0].buffer) : null;
        const labFile = files['labFiles'] ? await uploadToCloudinary(files['labFiles'][0].buffer) : null;

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
                        medFile || currentVisit.medication_file, ecgFile ? 'نعم' : currentVisit.has_ecg, ecgFile || currentVisit.ecg_file,
                        echoFile ? 'نعم' : currentVisit.has_rays, echoFile || currentVisit.rays_file,
                        otherFile ? 'نعم' : currentVisit.has_other_rays, otherFile || currentVisit.other_rays_file,
                        labFile ? 'نعم' : currentVisit.has_labs, labFile || currentVisit.labs_file, visitId
                    ]
                });
            }
        } else {
            await db.execute({
                sql: `
                    INSERT INTO visits (
                        patient_id, visit_date, visit_type, diagnosis, medication_type, medication_text, 
                        medication_file, has_ecg, ecg_file, has_rays, rays_file, has_other_rays, 
                        other_rays_file, has_labs, labs_file
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                args: [
                    patientId, visitDate, finalVisitType, finalDiagnosis || '', medicationType || 'text', medicationText || '', 
                    medFile, ecgFile ? 'نعم' : 'لا', ecgFile, echoFile ? 'نعم' : 'لا', echoFile, 
                    otherFile ? 'نعم' : 'لا', otherFile, labFile ? 'نعم' : 'لا', labFile
                ]
            });
        }

        res.json({ success: true, message: 'تم حفظ البيانات بنجاح' });
    } catch (error) {
        console.error("Save Error:", error);
        res.status(500).json({ error: error.message || 'حدث خطأ أثناء تنفيذ العملية' });
    }
});

// 2. جلب قائمة المرضى وزياراتهم
app.get('/api/patients', async (req, res) => {
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

// 3. حذف مريض
app.delete('/api/patient/:id', async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM patients WHERE id = ?', args: [req.params.id] });
        res.json({ success: true, message: 'تم حذف سجل المريض بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء عملية الحذف' });
    }
});

// 4. حذف زيارة
app.delete('/api/visit/:id', async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM visits WHERE id = ?', args: [req.params.id] });
        res.json({ success: true, message: 'تم حذف الزيارة بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء حذف الزيارة' });
    }
});

// 5. ميزة تنزيل النسخة الاحتياطية بالكامل على جهاز الكمبيوتر (Backup ZIP)
app.get('/api/export-backup', async (req, res) => {
    try {
        const patientsRes = await db.execute('SELECT * FROM patients');
        const visitsRes = await db.execute('SELECT * FROM visits');

        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment(`clinic_backup_${new Date().toISOString().split('T')[0]}.zip`);
        archive.pipe(res);

        // إرفاق ملف البيانات
        const databaseData = JSON.stringify({ patients: patientsRes.rows, visits: visitsRes.rows }, null, 2);
        archive.append(databaseData, { name: 'database_backup.json' });

        // تجميع المستندات والصور
        const fileUrls = [];
        visitsRes.rows.forEach(v => {
            ['medication_file', 'ecg_file', 'rays_file', 'other_rays_file', 'labs_file'].forEach(key => {
                if (v[key]) fileUrls.push(v[key]);
            });
        });

        for (let i = 0; i < fileUrls.length; i++) {
            const url = fileUrls[i];
            try {
                const response = await axios.get(url, { responseType: 'arraybuffer' });
                const fileName = `attachments/file_${i + 1}_${url.split('/').pop()}`;
                archive.append(Buffer.from(response.data), { name: fileName });
            } catch (e) {
                console.error(`Failed to download file for backup: ${url}`);
            }
        }

        await archive.finalize();
    } catch (error) {
        console.error("Backup Error:", error);
        res.status(500).send("خطأ أثناء إنشاء النسخة الاحتياطية");
    }
});

app.listen(PORT, () => {
    console.log(`✅ سيرفر العيادة يعمل بنجاح على البورت: ${PORT}`);
});
