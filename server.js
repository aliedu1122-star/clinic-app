require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد Cloudinary للتخزين الدائم للصور والملفات
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// إعداد التخزين السحابي للملفات
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'clinic_uploads',
        resource_type: 'auto'
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

// الاتصال بقاعدة بيانات Turso
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "",
    authToken: process.env.TURSO_AUTH_TOKEN || ""
});

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
        console.log("✅ تم الاتصال بقاعدة بيانات Turso وإعداد الجداول بنجاح.");
    } catch (err) {
        console.error("❌ خطأ في تهيئة قاعدة بيانات Turso:", err);
    }
}
initDb();

const cpUpload = upload.fields([
    { name: 'medicationFile', maxCount: 1 },
    { name: 'ecgFile', maxCount: 1 },
    { name: 'raysFile', maxCount: 1 },
    { name: 'otherRaysFile', maxCount: 1 },
    { name: 'labsFile', maxCount: 1 }
]);

// حفظ / تعديل زيارة ومريض
app.post('/api/visit', (req, res, next) => {
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
        const finalVisitType = (visitType === 'آخر' && customVisitType) ? customVisitType.trim() : visitType;
        const finalDiagnosis = (diagnosis === 'آخر' && customDiagnosis) ? customDiagnosis.trim() : diagnosis;

        let patientId = passedPatientId ? parseInt(passedPatientId) : null;

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

        const medFile = req.files?.['medicationFile']?.[0]?.path || null;
        const ecgFile = req.files?.['ecgFile']?.[0]?.path || null;
        const raysFile = req.files?.['raysFile']?.[0]?.path || null;
        const otherRaysFile = req.files?.['otherRaysFile']?.[0]?.path || null;
        const labsFile = req.files?.['labsFile']?.[0]?.path || null;

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
                        visitDate, finalVisitType || 'كشف', finalDiagnosis || '', medicationType || 'text', medicationText || '',
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
                args: [patientId, visitDate, finalVisitType || 'كشف', finalDiagnosis || '', medicationType || 'text', medicationText || '', medFile, hasEcg || 'لا', ecgFile, hasRays || 'لا', raysFile, hasOtherRays || 'لا', otherRaysFile, hasLabs || 'لا', labsFile]
            });
        }

        res.json({ success: true, message: 'تم حفظ البيانات بنجاح' });
    } catch (error) {
        console.error("Save Error:", error);
        res.status(400).json({ error: error.message || 'حدث خطأ أثناء تنفيذ العملية' });
    }
});

// جلب قائمة المرضى وزياراتهم
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
        console.error(error);
        res.status(500).json({ error: 'خطأ في جلب بيانات المرضى' });
    }
});

// حذف مريض
app.delete('/api/patient/:id', async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM patients WHERE id = ?', args: [req.params.id] });
        res.json({ success: true, message: 'تم حذف سجل المريض بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء عملية الحذف' });
    }
});

// حذف زيارة
app.delete('/api/visit/:id', async (req, res) => {
    try {
        await db.execute({ sql: 'DELETE FROM visits WHERE id = ?', args: [req.params.id] });
        res.json({ success: true, message: 'تم حذف الزيارة بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء حذف الزيارة' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ سيرفر العيادة المؤمن شغال بنجاح على البورت: ${PORT}`);
});
