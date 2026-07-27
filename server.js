require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client/http');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

// معالجة رابط قاعدة البيانات
let rawUrl = (process.env.TURSO_DATABASE_URL || "").trim().replace(/[\r\n]+/g, "");
if (rawUrl.startsWith("libsql://")) {
    rawUrl = rawUrl.replace("libsql://", "https://");
} else if (rawUrl !== "" && !rawUrl.startsWith("https://")) {
    rawUrl = "https://" + rawUrl;
}

// إنشاء اتصال HTTP مباشر
const db = createClient({
    url: rawUrl,
    authToken: (process.env.TURSO_AUTH_TOKEN || "").trim()
});

// إنشاء الجداول في حالة عدم وجودها
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

// دالة مساعدة لحذف الصور والملفات من Cloudinary
async function deleteCloudinaryFile(fileUrl) {
    if (!fileUrl) return;
    try {
        const parts = fileUrl.split('/');
        const fileNameWithExt = parts.pop();
        const folderName = parts.pop();
        const publicId = `${folderName}/${fileNameWithExt.split('.')[0]}`;
        await cloudinary.uploader.destroy(publicId);
    } catch (err) {
        console.error("Cloudinary Delete Error:", err.message || err);
    }
}

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

        const newMedFile = req.files?.['medicationFile']?.[0]?.path || null;
        const newEcgFile = req.files?.['ecgFile']?.[0]?.path || null;
        const newRaysFile = req.files?.['raysFile']?.[0]?.path || null;
        const newOtherRaysFile = req.files?.['otherRaysFile']?.[0]?.path || null;
        const newLabsFile = req.files?.['labsFile']?.[0]?.path || null;

        if (visitId && visitId !== '') {
            let currentVisitRes = await db.execute({
                sql: 'SELECT * FROM visits WHERE id = ?',
                args: [visitId]
            });

            if (currentVisitRes.rows.length > 0) {
                const current = currentVisitRes.rows[0];

                if (newMedFile && current.medication_file) await deleteCloudinaryFile(current.medication_file);
                if (newEcgFile && current.ecg_file) await deleteCloudinaryFile(current.ecg_file);
                if (newRaysFile && current.rays_file) await deleteCloudinaryFile(current.rays_file);
                if (newOtherRaysFile && current.other_rays_file) await deleteCloudinaryFile(current.other_rays_file);
                if (newLabsFile && current.labs_file) await deleteCloudinaryFile(current.labs_file);

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
                        newMedFile || current.medication_file, 
                        hasEcg || (newEcgFile || current.ecg_file ? 'نعم' : 'لا'), newEcgFile || current.ecg_file,
                        hasRays || (newRaysFile || current.rays_file ? 'نعم' : 'لا'), newRaysFile || current.rays_file,
                        hasOtherRays || (newOtherRaysFile || current.other_rays_file ? 'نعم' : 'لا'), newOtherRaysFile || current.other_rays_file,
                        hasLabs || (newLabsFile || current.labs_file ? 'نعم' : 'لا'), newLabsFile || current.labs_file, 
                        visitId
                    ]
                });
            }
        } else {
            await db.execute({
                sql: `
                    INSERT INTO visits (patient_id, visit_date, visit_type, diagnosis, medication_type, medication_text, medication_file, has_ecg, ecg_file, has_rays, rays_file, has_other_rays, other_rays_file, has_labs, labs_file)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                args: [
                    patientId, visitDate, finalVisitType, finalDiagnosis || '', medicationType || 'text', medicationText || '', 
                    newMedFile, 
                    hasEcg || (newEcgFile ? 'نعم' : 'لا'), newEcgFile, 
                    hasRays || (newRaysFile ? 'نعم' : 'لا'), newRaysFile, 
                    hasOtherRays || (newOtherRaysFile ? 'نعم' : 'لا'), newOtherRaysFile, 
                    hasLabs || (newLabsFile ? 'نعم' : 'لا'), newLabsFile
                ]
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
        console.error("Fetch Error:", error);
        res.status(500).json({ error: 'خطأ في جلب بيانات المرضى' });
    }
});

// إنشاء وتنزيل نسخة احتياطية بصيغة ZIP
app.get('/api/backup', async (req, res) => {
    try {
        const patientsRes = await db.execute('SELECT * FROM patients');
        const visitsRes = await db.execute('SELECT * FROM visits');

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="clinic_backup_${Date.now()}.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => { throw err; });
        archive.pipe(res);

        archive.append(JSON.stringify(patientsRes.rows, null, 2), { name: 'patients.json' });
        archive.append(JSON.stringify(visitsRes.rows, null, 2), { name: 'visits.json' });

        await archive.finalize();
    } catch (error) {
        console.error("Backup Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'حدث خطأ أثناء إنشاء النسخة الاحتياطية' });
        }
    }
});

// حذف مريض ومسح ملفاته
app.delete('/api/patient/:id', async (req, res) => {
    try {
        const visitsRes = await db.execute({
            sql: 'SELECT medication_file, ecg_file, rays_file, other_rays_file, labs_file FROM visits WHERE patient_id = ?',
            args: [req.params.id]
        });

        for (const v of visitsRes.rows) {
            if (v.medication_file) await deleteCloudinaryFile(v.medication_file);
            if (v.ecg_file) await deleteCloudinaryFile(v.ecg_file);
            if (v.rays_file) await deleteCloudinaryFile(v.rays_file);
            if (v.other_rays_file) await deleteCloudinaryFile(v.other_rays_file);
            if (v.labs_file) await deleteCloudinaryFile(v.labs_file);
        }

        await db.execute({ sql: 'DELETE FROM patients WHERE id = ?', args: [req.params.id] });
        res.json({ success: true, message: 'تم حذف سجل المريض بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء عملية الحذف' });
    }
});

// حذف زيارة ومسح ملفاتها
app.delete('/api/visit/:id', async (req, res) => {
    try {
        const visitRes = await db.execute({
            sql: 'SELECT medication_file, ecg_file, rays_file, other_rays_file, labs_file FROM visits WHERE id = ?',
            args: [req.params.id]
        });

        if (visitRes.rows.length > 0) {
            const v = visitRes.rows[0];
            if (v.medication_file) await deleteCloudinaryFile(v.medication_file);
            if (v.ecg_file) await deleteCloudinaryFile(v.ecg_file);
            if (v.rays_file) await deleteCloudinaryFile(v.rays_file);
            if (v.other_rays_file) await deleteCloudinaryFile(v.other_rays_file);
            if (v.labs_file) await deleteCloudinaryFile(v.labs_file);
        }

        await db.execute({ sql: 'DELETE FROM visits WHERE id = ?', args: [req.params.id] });
        res.json({ success: true, message: 'تم حذف الزيارة بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء حذف الزيارة' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ سيرفر العيادة يعمل بنجاح على البورت: ${PORT}`);
});
