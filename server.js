const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'patients.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// قراءة البيانات
function getPatients() {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    }
    const data = fs.readFileSync(DATA_FILE);
    return JSON.parse(data);
}

// حفظ البيانات
function savePatients(patients) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(patients, null, 2));
}

// API جلب المرضى
app.get('/api/patients', (req, res) => {
    res.json(getPatients());
});

// API إضافة مريض
app.post('/api/patients', (req, res) => {
    const patients = getPatients();
    const newPatient = {
        id: Date.now(),
        name: req.body.name,
        age: req.body.age,
        gender: req.body.gender,
        phone: req.body.phone,
        alerts: req.body.alerts || '',
        visits: []
    };
    patients.push(newPatient);
    savePatients(patients);
    res.json(newPatient);
});

// API إضافة زيارة
app.post('/api/visits', (req, res) => {
    const patients = getPatients();
    const { patientId, diagnosis, treatment, notes } = req.body;
    
    const patient = patients.find(p => p.id == patientId);
    if (patient) {
        if (!patient.visits) patient.visits = [];
        patient.visits.push({
            id: Date.now(),
            date: new Date().toISOString(),
            diagnosis,
            treatment,
            notes
        });
        savePatients(patients);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "المريض غير موجود" });
    }
});

// API تحميل النسخة الاحتياطية
app.get('/api/backup', (req, res) => {
    res.download(DATA_FILE, `backup_clinic_${new Date().toISOString().split('T')[0]}.json`);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
