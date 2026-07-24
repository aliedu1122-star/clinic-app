const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const db = new Database('./clinic.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        age INTEGER,
        phone TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER,
        visit_date TEXT,
        visit_type TEXT,
        diagnosis TEXT,
        medication_type TEXT,
        medication_text TEXT,
        medication_file TEXT,
        has_ecg TEXT,
        ecg_file TEXT,
        has_rays TEXT,
        rays_file TEXT,
        has_other_rays TEXT,
        other_rays_file TEXT,
        has_labs TEXT,
        labs_file TEXT,
        FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );
`);

const requiredColumns = [
    { name: 'visit_type', type: 'TEXT' },
    { name: 'medication_type', type: 'TEXT' },
    { name: 'medication_text', type: 'TEXT' },
    { name: 'medication_file', type: 'TEXT' },
    { name: 'has_ecg', type: 'TEXT' },
    { name: 'ecg_file', type: 'TEXT' },
    { name: 'has_rays', type: 'TEXT' },
    { name: 'rays_file', type: 'TEXT' },
    { name: 'has_other_rays', type: 'TEXT' },
    { name: 'other_rays_file', type: 'TEXT' },
    { name: 'has_labs', type: 'TEXT' },
    { name: 'labs_file', type: 'TEXT' }
];

requiredColumns.forEach(col => {
    try { db.exec(`ALTER TABLE visits ADD COLUMN ${col.name} ${col.type};`); } catch (e) {}
});

const cpUpload = upload.fields([
    { name: 'medicationFile', maxCount: 1 },
    { name: 'ecgFile', maxCount: 1 },
    { name: 'raysFile', maxCount: 1 },
    { name: 'otherRaysFile', maxCount: 1 },
    { name: 'labsFile', maxCount: 1 }
]);

// ----------------------------------------------------
// رابط النسخة الاحتياطية المُعدل (تقسيم المرضى في مجلدات)
// ----------------------------------------------------
app.get('/api/backup', async (req, res) => {
    const dateStr = new Date().toISOString().split('T')[0];
    const tempDbPath = `./clinic_backup_temp_${dateStr}.db`;
    const zipFilename = `clinic_patients_backup_${dateStr}.zip`;

    try {
        // 1. عمل نسخة احتياطية مؤقتة من DB لاستمرار القراءة دون قفل الملف
        await db.backup(tempDbPath);

        res.attachment(zipFilename);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('error', (err) => { throw err; });

        res.on('finish', () => {
            if (fs.existsSync(tempDbPath)) {
                fs.unlinkSync(tempDbPath);
            }
        });

        archive.pipe(res);

        // 2. إدراج نسخة الـ DB الأساسية في الجذر
        archive.file(tempDbPath, { name: `DATABASE_BACKUP_${dateStr}.db` });

        // 3. جلب جميع المرضى وزياراتهم من القاعدة
        const rows = db.prepare(`
            SELECT p.id as patient_id, p.name, p.age, p.phone,
                   v.id as visit_id, v.visit_date, v.visit_type, v.diagnosis, 
                   v.medication_type, v.medication_text, v.medication_file,
                   v.ecg_file, v.rays_file, v.other_rays_file, v.labs_file
            FROM patients p
            LEFT JOIN visits v ON p.id = v.patient_id
            ORDER BY p.id ASC, v.visit_date ASC
        `).all();

        // تجميع الزيارات حسب المريض
        const patientsMap = {};
        rows.forEach(row => {
            if (!patientsMap[row.patient_id]) {
                patientsMap[row.patient_id] = {
                    name: row.name,
                    age: row.age,
                    phone: row.phone,
                    visits: []
                };
            }
            if (row.visit_id) {
                patientsMap[row.patient_id].visits.push(row);
            }
        });

        const uploadsDir = path.join(__dirname, 'uploads');

        // 4. المرور على كل مريض وإنشاء مجلد باسمه ورقم هاتفه
        for (const pId in patientsMap) {
            const patient = patientsMap[pId];
            // معالجة اسم المريض لإزالة الرموز غير المسموحة في الأسماء
            const safeName = patient.name.replace(/[\\/:*?"<>|]/g, '_').trim();
            const folderName = `المرضى/${safeName}_${patient.phone}`;

            let txtContent = `=========================================\n`;
            txtContent += `ملف مريض: ${patient.name}\n`;
            txtContent += `السن: ${patient.age} سنة | الهاتف: ${patient.phone}\n`;
            txtContent += `إجمالي الزيارات: ${patient.visits.length}\n`;
            txtContent += `=========================================\n\n`;

            patient.visits.forEach((v, index) => {
                txtContent += `[زيارة رقم ${index + 1}] - التاريخ: ${v.visit_date || 'غير محدد'}\n`;
                txtContent += `نوع الزيارة: ${v.visit_type || '-'}\n`;
                txtContent += `التشخيص: ${v.diagnosis || '-'}\n`;
                if (v.medication_text) {
                    txtContent += `الروشتة النصية:\n${v.medication_text}\n`;
                }
                txtContent += `-----------------------------------------\n`;

                // نقل المرفقات للمجلد الخاص بالمريض بأسماء واضحة
                const filesList = [
                    { file: v.medication_file, label: 'روشتة' },
                    { file: v.ecg_file, label: 'رسم_قلب' },
                    { file: v.rays_file, label: 'إيكو_أشعة' },
                    { file: v.other_rays_file, label: 'أشعات_أخرى' },
                    { file: v.labs_file, label: 'تحاليل' }
                ];

                filesList.forEach(item => {
                    if (item.file) {
                        const fullPath = path.join(uploadsDir, item.file);
                        if (fs.existsSync(fullPath)) {
                            const ext = path.extname(item.file);
                            const zipFilePath = `${folderName}/${v.visit_date}_${item.label}_ز${v.visit_id}${ext}`;
                            archive.file(fullPath, { name: zipFilePath });
                        }
                    }
                });
            });

            // إضافة ملف السجل الطبي المكتوب داخل مجلد المريض
            archive.append(txtContent, { name: `${folderName}/سجل_الحالة.txt` });
        }

        await archive.finalize();

    } catch (error) {
        console.error('Backup Error:', error);
        if (fs.existsSync(tempDbPath)) {
            fs.unlinkSync(tempDbPath);
        }
        if (!res.headersSent) {
            res.status(500).send("حدث خطأ أثناء إنشاء النسخة الاحتياطية");
        }
    }
});

app.post('/api/visit', cpUpload, (req, res) => {
    try {
        const { visitId, name, age, phone, visitDate, visitType, customVisitType, diagnosis, customDiagnosis, medicationType, medicationText, hasEcg, hasRays, hasOtherRays, hasLabs } = req.body;
        
        const finalVisitType = (visitType === 'آخر' && customVisitType) ? customVisitType : visitType;
        const finalDiagnosis = (diagnosis === 'آخر' && customDiagnosis) ? customDiagnosis : diagnosis;

        let patient = db.prepare('SELECT id FROM patients WHERE phone = ?').get(phone);
        let patientId;

        if (patient) {
            patientId = patient.id;
            db.prepare('UPDATE patients SET name = ?, age = ? WHERE id = ?').run(name, age, patientId);
        } else {
            const info = db.prepare('INSERT INTO patients (name, age, phone) VALUES (?, ?, ?)').run(name, age, phone);
            patientId = info.lastInsertRowid;
        }

        const medFile = req.files && req.files['medicationFile'] ? req.files['medicationFile'][0].filename : null;
        const ecgFile = req.files && req.files['ecgFile'] ? req.files['ecgFile'][0].filename : null;
        const raysFile = req.files && req.files['raysFile'] ? req.files['raysFile'][0].filename : null;
        const otherRaysFile = req.files && req.files['otherRaysFile'] ? req.files['otherRaysFile'][0].filename : null;
        const labsFile = req.files && req.files['labsFile'] ? req.files['labsFile'][0].filename : null;

        if (visitId) {
            const currentVisit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
            db.prepare(`
                UPDATE visits SET 
                    visit_date = ?, visit_type = ?, diagnosis = ?, medication_type = ?, medication_text = ?,
                    medication_file = ?, has_ecg = ?, ecg_file = ?, has_rays = ?, rays_file = ?,
                    has_other_rays = ?, other_rays_file = ?, has_labs = ?, labs_file = ?
                WHERE id = ?
            `).run(
                visitDate, finalVisitType || 'كشف', finalDiagnosis || '', medicationType || 'text', medicationText || '',
                medFile || currentVisit.medication_file, hasEcg || 'لا', ecgFile || currentVisit.ecg_file,
                hasRays || 'لا', raysFile || currentVisit.rays_file,
                hasOtherRays || 'لا', otherRaysFile || currentVisit.other_rays_file,
                hasLabs || 'لا', labsFile || currentVisit.labs_file, visitId
            );
        } else {
            db.prepare(`
                INSERT INTO visits (patient_id, visit_date, visit_type, diagnosis, medication_type, medication_text, medication_file, has_ecg, ecg_file, has_rays, rays_file, has_other_rays, other_rays_file, has_labs, labs_file)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(patientId, visitDate, finalVisitType || 'كشف', finalDiagnosis || '', medicationType || 'text', medicationText || '', medFile, hasEcg || 'لا', ecgFile, hasRays || 'لا', raysFile, hasOtherRays || 'لا', otherRaysFile, hasLabs || 'لا', labsFile);
        }

        res.json({ success: true, message: 'تم الحفظ بنجاح' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/patients', (req, res) => {
    try {
        const query = req.query.q || '';
        const rows = db.prepare(`
            SELECT p.id, p.name, p.age, p.phone, 
                   v.id as visit_id, v.visit_date, v.visit_type, v.diagnosis, v.medication_type, 
                   v.medication_text, v.medication_file, v.has_ecg, v.ecg_file, v.has_rays, v.rays_file,
                   v.has_other_rays, v.other_rays_file, v.has_labs, v.labs_file
            FROM patients p
            LEFT JOIN visits v ON p.id = v.patient_id
            WHERE p.name LIKE ? OR p.phone LIKE ?
            ORDER BY v.visit_date ASC
        `).all(`%${query}%`, `%${query}%`);

        const patientsMap = {};
        rows.forEach(row => {
            if (!patientsMap[row.id]) {
                patientsMap[row.id] = { id: row.id, name: row.name, age: row.age, phone: row.phone, visits: [] };
            }
            if (row.visit_date) {
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
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/patient/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM visits WHERE patient_id = ?').run(req.params.id);
        db.prepare('DELETE FROM patients WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'تم حذف ملف المريض بالكامل' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/visit/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM visits WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'تم حذف الزيارة' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ سيرفر العيادة شغال بنجاح على البورت: ${PORT}`);
});
