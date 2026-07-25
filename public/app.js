document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupBookingForm();
    setupSearchForm();
    setupBackupButton();
});

function setupTabs() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabId = button.getAttribute('data-tab');
            navButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));

            button.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        });
    });
}

function setupBookingForm() {
    const form = document.getElementById('booking-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'جاري الحفظ والرفع...';

        const formData = new FormData(form);

        try {
            const response = await fetch('/api/bookings', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (response.ok) {
                alert('تم تسجيل كافة البيانات والمرفقات بنجاح!');
                form.reset();
            } else {
                alert('حدث خطأ: ' + (result.message || 'فشل حفظ البيانات'));
            }
        } catch (error) {
            console.error(error);
            alert('تعذر الاتصال بالسيرفر.');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'حفظ الحالة بالكامل';
        }
    });
}

function setupSearchForm() {
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');

    if (!searchBtn) return;

    searchBtn.addEventListener('click', async () => {
        const query = searchInput.value.trim();
        if (!query) return alert('أدخل كلمة للبحث');

        searchResults.innerHTML = '<p>جاري البحث...</p>';

        try {
            const response = await fetch(`/api/bookings/search?q=${encodeURIComponent(query)}`);
            const data = await response.json();

            if (response.ok && data.length > 0) {
                searchResults.innerHTML = data.map(item => `
                    <div class="result-card">
                        <h3>${item.patient_name || 'بدون اسم'}</h3>
                        <p><strong>الهاتف:</strong> ${item.phone || '-'}</p>
                        <p><strong>التشخيص:</strong> ${item.diagnosis || '-'}</p>
                        <p><strong>نص الروشتة:</strong> ${item.prescription_text || '-'}</p>
                        <div style="margin-top: 10px;">
                            ${item.ecg_url ? `<a href="${item.ecg_url}" target="_blank" class="file-link">❤️ رسم قلب</a>` : ''}
                            ${item.echo_url ? `<a href="${item.echo_url}" target="_blank" class="file-link">🔊 إيكو</a>` : ''}
                            ${item.xray_url ? `<a href="${item.xray_url}" target="_blank" class="file-link">🩻 أشعة</a>` : ''}
                            ${item.prescription_url ? `<a href="${item.prescription_url}" target="_blank" class="file-link">📝 صورة الروشتة</a>` : ''}
                        </div>
                    </div>
                `).join('');
            } else {
                searchResults.innerHTML = '<p>لم يتم العثور على نتائج.</p>';
            }
        } catch (error) {
            searchResults.innerHTML = '<p>حدث خطأ أثناء البحث.</p>';
        }
    });
}

function setupBackupButton() {
    const backupBtn = document.getElementById('download-backup-btn');
    if (!backupBtn) return;

    backupBtn.addEventListener('click', () => {
        window.location.href = '/api/admin/backup';
    });
}
