let globalPatientsData = [];

document.addEventListener('DOMContentLoaded', () => {
    const visitDateInput = document.getElementById('visitDate');
    if (visitDateInput) visitDateInput.valueAsDate = new Date();
    loadPatients();
});

function toggleCustomInput(selectId, divId) {
    const select = document.getElementById(selectId);
    const div = document.getElementById(divId);
    if (select && div) {
        div.classList.toggle('d-none', select.value !== 'آخر');
    }
}

function toggleMedicationType(type) {
    const textDiv = document.getElementById('medicationTextDiv');
    const imageDiv = document.getElementById('medicationImageDiv');

    if (type === 'text') {
        if (textDiv) textDiv.classList.remove('d-none');
        if (imageDiv) imageDiv.classList.add('d-none');
        const medImg = document.getElementById('medicationImage');
        if (medImg) medImg.value = '';
    } else {
        if (imageDiv) imageDiv.classList.remove('d-none');
        if (textDiv) textDiv.classList.add('d-none');
        const medText = document.getElementById('medicationText');
        if (medText) medText.value = '';
    }
}

function resetForm() {
    const form = document.getElementById('visitForm');
    if (form) form.reset();
    
    document.getElementById('visitId').value = '';
    document.getElementById('patientId').value = '';
    
    const visitDateInput = document.getElementById('visitDate');
    if (visitDateInput) visitDateInput.valueAsDate = new Date();
    
    document.getElementById('customVisitTypeDiv').classList.add('d-none');
    document.getElementById('customDiagnosisDiv').classList.add('d-none');
    
    toggleMedicationType('text');
    document.querySelectorAll('input[type="file"]').forEach(input => input.value = '');

    document.getElementById('formTitle').innerHTML = '<i class="fa-solid fa-user-plus me-2"></i>تسجيل زيارة جديدة';
    document.getElementById('resetBtn').classList.add('d-none');
}

document.getElementById('visitForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(e.target);

    // معالجة القيم المخصصة
    if (formData.get('visitType') === 'آخر') {
        formData.set('visitType', formData.get('customVisitType'));
    }
    if (formData.get('diagnosis') === 'آخر') {
        formData.set('diagnosis', formData.get('customDiagnosis'));
    }

    try {
        const res = await fetch('/api/visit', {
            method: 'POST',
            body: formData
        });

        const result = await res.json();

        if (res.ok) {
            alert('تم حفظ البيانات بنجاح!');
            resetForm();
            loadPatients();
        } else {
            alert(`خطأ: ${result.error || 'فشل حفظ البيانات'}`);
        }
    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء الاتصال بالسيرفر.');
    }
});

// جلب المرضى باستخدام الكويري الصحيح (q) المتوافق مع backend
async function loadPatients() {
    const searchVal = document.getElementById('searchInput').value.trim();
    const container = document.getElementById('patientsContainer');

    try {
        // تم التغيير إلى q= ليطابق Backend
        const res = await fetch(`/api/patients?q=${encodeURIComponent(searchVal)}`);
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        globalPatientsData = await res.json();

        if (!globalPatientsData || globalPatientsData.length === 0) {
            container.innerHTML = `
                <div class="text-center text-muted my-5">
                    <i class="fa-solid fa-folder-open fa-3x mb-3"></i>
                    <p>لا توجد نتائج للعرض</p>
                </div>`;
            return;
        }

        container.innerHTML = globalPatientsData.map(p => renderPatientCard(p)).join('');
    } catch (err) {
        console.error('Error loading patients:', err);
        container.innerHTML = `<div class="alert alert-danger text-center">حدث خطأ في جلب البيانات من السيرفر.</div>`;
    }
}

function renderPatientCard(patient) {
    const visits = patient.visits || [];

    return `
        <div class="card patient-card border-0 mb-3">
            <div class="card-body">
                <div class="d-flex justify-content-between align-items-start border-bottom pb-2 mb-3">
                    <div>
                        <h5 class="fw-bold text-dark mb-1">${escapeHTML(patient.name)}</h5>
                        <div class="text-muted small">
                            <span class="me-3"><i class="fa-solid fa-phone me-1"></i>${escapeHTML(patient.phone)}</span>
                            ${patient.age ? `<span><i class="fa-solid fa-cake-candles me-1"></i>${patient.age} سنة</span>` : ''}
                        </div>
                    </div>
                    <span class="badge bg-primary-subtle text-primary badge-custom">
                        ${visits.length} زيارات
                    </span>
                </div>

                <div class="accordion accordion-flush" id="accordion-${patient.id}">
                    ${visits.map((v, index) => renderVisitItem(v, patient, index)).join('')}
                </div>
            </div>
        </div>
    `;
}

function renderVisitItem(visit, patient, index) {
    const accordionId = `visit-${patient.id}-${index}`;
    
    return `
        <div class="accordion-item border-0 bg-light rounded mb-2">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed bg-light rounded" type="button" data-bs-toggle="collapse" data-bs-target="#${accordionId}">
                    <div class="d-flex justify-content-between w-100 me-3 align-items-center">
                        <span class="fw-bold"><i class="fa-regular fa-calendar-check me-2 text-primary"></i>${visit.visit_date || ''}</span>
                        <span class="badge bg-secondary-subtle text-secondary me-2">${escapeHTML(visit.visit_type)}</span>
                        <span class="text-muted small">${escapeHTML(visit.diagnosis)}</span>
                    </div>
                </button>
            </h2>
            <div id="${accordionId}" class="accordion-collapse collapse" data-bs-parent="#accordion-${patient.id}">
                <div class="accordion-body bg-white border-top">
                    
                    <div class="d-flex justify-content-end mb-2">
                        <button class="btn btn-sm btn-outline-primary border-0 me-1" 
                            onclick="triggerEdit(${patient.id}, ${visit.id})" 
                            title="تعديل الزيارة">
                            <i class="fa-solid fa-pen me-1"></i>تعديل
                        </button>
                        <button class="btn btn-sm btn-outline-danger border-0" 
                            onclick="deleteVisit(${visit.id})" 
                            title="حذف الزيارة">
                            <i class="fa-solid fa-trash me-1"></i>حذف
                        </button>
                    </div>

                    <div class="mb-3">
                        <strong class="d-block text-muted small mb-1">الروشتة / العلاج:</strong>
                        ${visit.medication_text ? `<p class="mb-0 bg-light p-2 rounded text-dark">${escapeHTML(visit.medication_text)}</p>` : ''}
                        ${visit.medication_file ? `<a href="${visit.medication_file}" target="_blank" class="btn btn-sm btn-outline-secondary mt-1"><i class="fa-solid fa-image me-1"></i>عرض صورة الروشتة</a>` : ''}
                    </div>

                    ${renderAttachments(visit)}
                </div>
            </div>
        </div>
    `;
}

// عرض المرفقات بناءً على الهيكلية الصحيحة في Backend
function renderAttachments(visit) {
    const categories = [
        { key: 'ecg_file', title: 'رسم قلب (ECG)', icon: 'fa-wave-square text-danger' },
        { key: 'rays_file', title: 'إيكو (Echo)', icon: 'fa-ultrasound text-primary' },
        { key: 'other_rays_file', title: 'أشعة أخرى', icon: 'fa-box-archive text-secondary' },
        { key: 'labs_file', title: 'تحاليل (Labs)', icon: 'fa-vial text-warning' }
    ];

    let html = '';
    categories.forEach(cat => {
        if (visit[cat.key]) {
            html += `
                <div class="mt-2">
                    <strong class="d-block text-muted small mb-1"><i class="fa-solid ${cat.icon} me-1"></i>${cat.title}:</strong>
                    <a href="${visit[cat.key]}" target="_blank" class="btn btn-sm btn-light border text-truncate" style="max-width: 250px;">
                        <i class="fa-solid fa-file me-1"></i>عرض الملف المرفق
                    </a>
                </div>
            `;
        }
    });

    return html;
}

function triggerEdit(patientId, visitId) {
    const patient = globalPatientsData.find(p => p.id === patientId);
    if (!patient) return;

    const visit = patient.visits.find(v => v.id === visitId);
    if (!visit) return;

    document.getElementById('visitId').value = visit.id || '';
    document.getElementById('patientId').value = patient.id || '';
    document.getElementById('name').value = patient.name || '';
    document.getElementById('phone').value = patient.phone || '';
    document.getElementById('age').value = patient.age || '';
    document.getElementById('visitDate').value = visit.visit_date || '';

    const visitTypeSelect = document.getElementById('visitType');
    if (['كشف', 'استشارة', 'متابعة'].includes(visit.visit_type)) {
        visitTypeSelect.value = visit.visit_type;
        document.getElementById('customVisitTypeDiv').classList.add('d-none');
    } else {
        visitTypeSelect.value = 'آخر';
        document.getElementById('customVisitTypeDiv').classList.remove('d-none');
        document.getElementById('customVisitType').value = visit.visit_type || '';
    }

    const diagnosisSelect = document.getElementById('diagnosis');
    if (['ارتفاع ضغط الدم', 'قصور بالشرايين التاجية', 'ضعف بعضلة القلب'].includes(visit.diagnosis)) {
        diagnosisSelect.value = visit.diagnosis;
        document.getElementById('customDiagnosisDiv').classList.add('d-none');
    } else {
        diagnosisSelect.value = 'آخر';
        document.getElementById('customDiagnosisDiv').classList.remove('d-none');
        document.getElementById('customDiagnosis').value = visit.diagnosis || '';
    }

    if (visit.medication_text) {
        document.getElementById('medTextRadio').checked = true;
        toggleMedicationType('text');
        document.getElementById('medicationText').value = visit.medication_text;
    } else if (visit.medication_file) {
        document.getElementById('medImageRadio').checked = true;
        toggleMedicationType('image');
    }

    document.getElementById('formTitle').innerHTML = '<i class="fa-solid fa-pen-to-square me-2"></i>تعديل بيانات زيارة';
    document.getElementById('resetBtn').classList.remove('d-none');

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteVisit(visitId) {
    if (!confirm('هل أنت تأكد من رغبتك في حذف هذه الزيارة؟')) return;

    try {
        const res = await fetch(`/api/visit/${visitId}`, { method: 'DELETE' });
        if (res.ok) {
            loadPatients();
        } else {
            const result = await res.json();
            alert(`خطأ: ${result.error || 'فشل حذف الزيارة'}`);
        }
    } catch (err) {
        console.error(err);
        alert('حدث خطأ أثناء الاتصال بالسيرفر.');
    }
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
