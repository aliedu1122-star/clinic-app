require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client'); // استخدام مكتبة Turso
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. تفعيل حماية Helmet و Cors
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// إنشاء مجلد الرفع بشكل آمن
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// 2. تأمين Multer
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.pdf', '.doc', '.docx'];
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTENSIONS.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مسموح به! يُسمح فقط بالصور والملفات المستندية (PDF, DOC, Images)'));
        }
    }
});

// 3. إعداد الاتصال بقاعدة بيانات Turso السحابية
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "",
    authToken: process.env.TURSO_AUTH_TOKEN || ""
});

// إنشاء الجداول في Turso أوتوماتيكياً
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

// دالة مساعدة لحذف الملفات الفيزيائية
function deletePhysicalFiles(files) {
    files.forEach(file => {
        if (file) {
            const safePath = path.basename(file);
            const fullPath = path.join(uploadsDir, safePath);
            if (fs.existsSync(fullPath)) {
                try { fs.unlinkSync(fullPath); } catch (e) { console.error('فشل حذف الملف:', e); }
            }
        }
    });
}

// 4. حماية واستهلاك الملفات الفيزيائية
app.use('/uploads', express.static(uploadsDir));

// --- APIs ---

// حفظ / تعديل زيارة ومريض
app.post('/api/visit', (req, res, next) => {
    cpUpload(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: `خطأ في رفع الملف: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ error: err.message });
        }
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

        const medFile = req.files?.['medicationFile']?.[0]?.filename || null;
        const ecgFile = req.files?.['ecgFile']?.[0]?.filename || null;
        const raysFile = req.files?.['raysFile']?.[0]?.filename || null;
        const otherRaysFile = req.files?.['otherRaysFile']?.[0]?.filename || null;
        const labsFile = req.files?.['labsFile']?.[0]?.filename || null;

        if (visitId && visitId !== '') {
            let currentVisitRes = await db.execute({
                sql: 'SELECT * FROM visits WHERE id = ?',
                args: [visitId]
            });

            if (currentVisitRes.rows.length > 0) {
                const currentVisit = currentVisitRes.rows[0];
                if (medFile && currentVisit.medication_file) deletePhysicalFiles([currentVisit.medication_file]);
                if (ecgFile && currentVisit.ecg_file) deletePhysicalFiles([currentVisit.ecg_file]);
                if (raysFile && currentVisit.rays_file) deletePhysicalFiles([currentVisit.rays_file]);
                if (otherRaysFile && currentVisit.other_rays_file) deletePhysicalFiles([currentVisit.other_rays_file]);
                if (labsFile && currentVisit.labs_file) deletePhysicalFiles([currentVisit.labs_file]);

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

// حذف مريض بكافة زياراته وملفاته
app.delete('/api/patient/:id', async (req, res) => {
    const patientId = req.params.id;
    try {
        const visitsRes = await db.execute({
            sql: 'SELECT medication_file, ecg_file, rays_file, other_rays_file, labs_file FROM visits WHERE patient_id = ?',
            args: [patientId]
        });

        visitsRes.rows.forEach(v => {
            deletePhysicalFiles([v.medication_file, v.ecg_file, v.rays_file, v.other_rays_file, v.labs_file]);
        });

        await db.execute({
            sql: 'DELETE FROM patients WHERE id = ?',
            args: [patientId]
        });

        res.json({ success: true, message: 'تم حذف سجل المريض وكافة ملفاته بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء عملية الحذف' });
    }
});

// حذف زيارة محددة
app.delete('/api/visit/:id', async (req, res) => {
    const visitId = req.params.id;
    try {
        const visitRes = await db.execute({
            sql: 'SELECT medication_file, ecg_file, rays_file, other_rays_file, labs_file FROM visits WHERE id = ?',
            args: [visitId]
        });

        if (visitRes.rows.length > 0) {
            const visit = visitRes.rows[0];
            deletePhysicalFiles([visit.medication_file, visit.ecg_file, visit.rays_file, visit.other_rays_file, visit.labs_file]);
        }

        await db.execute({
            sql: 'DELETE FROM visits WHERE id = ?',
            args: [visitId]
        });

        res.json({ success: true, message: 'تم حذف الزيارة وملفاتها بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ أثناء حذف الزيارة' });
    }
});

// إنشاء نسخة احتياطية الشاملة
app.get('/api/backup', async (req, res) => {
    const dateStr = new Date().toISOString().split('T')[0];
    const zipFilename = `clinic_patients_backup_${dateStr}.zip`;

    try {
        res.attachment(zipFilename);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        const rowsRes = await db.execute(`
            SELECT p.id as patient_id, p.name, p.age, p.phone,
                   v.id as visit_id, v.visit_date, v.visit_type, v.diagnosis, 
                   v.medication_type, v.medication_text, v.medication_file,
                   v.ecg_file, v.rays_file, v.other_rays_file, v.labs_file
            FROM patients p
            LEFT JOIN visits v ON p.id = v.patient_id
            ORDER BY p.id ASC, v.visit_date ASC
        `);

        const patientsMap = {};
        rowsRes.rows.forEach(row => {
            if (!patientsMap[row.patient_id]) {
                patientsMap[row.patient_id] = {
                    name: row.name, age: row.age, phone: row.phone, visits: []
                };
            }
            if (row.visit_id) patientsMap[row.patient_id].visits.push(row);
        });

        for (const pId in patientsMap) {
            const patient = patientsMap[pId];
            const safeName = patient.name.replace(/[\\/:*?"<>|]/g, '_').trim();
            const folderName = `المرضى/${safeName}_${patient.phone}`;

            let txtContent = `=========================================\n`;
            txtContent += `ملف مريض: ${patient.name}\nالسن: ${patient.age || 'غير محدد'} سنة | الهاتف: ${patient.phone}\nإجمالي الزيارات: ${patient.visits.length}\n`;
            txtContent += `=========================================\n\n`;

            patient.visits.forEach((v, index) => {
                txtContent += `[زيارة رقم ${index + 1}] - التاريخ: ${v.visit_date || 'غير محدد'}\n`;
                txtContent += `نوع الزيارة: ${v.visit_type || '-'}\nالتشخيص: ${v.diagnosis || '-'}\n`;
                if (v.medication_text) txtContent += `الروشتة النصية:\n${v.medication_text}\n`;
                txtContent += `-----------------------------------------\n`;

                const filesList = [
                    { file: v.medication_file, label: 'روشتة' },
                    { file: v.ecg_file, label: 'رسم_قلب' },
                    { file: v.rays_file, label: 'إيكو_أشعة' },
                    { file: v.other_rays_file, label: 'أشعات_أخرى' },
                    { file: v.labs_file, label: 'تحاليل' }
                ];

                filesList.forEach(item => {
                    if (item.file) {
                        const fullPath = path.join(uploadsDir, path.basename(item.file));
                        if (fs.existsSync(fullPath)) {
                            const ext = path.extname(item.file);
                            archive.file(fullPath, { name: `${folderName}/${v.visit_date || 'تاريخ'}_${item.label}_ز${v.visit_id}${ext}` });
                        }
                    }
                });
            });

            archive.append(txtContent, { name: `${folderName}/سجل_الحالة.txt` });
        }

        await archive.finalize();
    } catch (error) {
        console.error('Backup Error:', error);
        if (!res.headersSent) res.status(500).send("حدث خطأ أثناء إنشاء النسخة الاحتياطية");
    }
});

app.listen(PORT, () => {
    console.log(`✅ سيرفر العيادة المؤمن شغال بنجاح على البورت: ${PORT}`);
});
