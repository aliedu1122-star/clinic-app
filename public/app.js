// المتغيرات العامة
let currentTab = 'new-booking';

// عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupBookingForm();
    setupSearchForm();
    setupBackupButton();
});

// 1. التبديل بين الشاشات
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
            currentTab = tabId;
        });
    });
}

// 2. إرسال حجز جديد
function setupBookingForm() {
    const form = document.getElementById('booking-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'جاري الحفظ...';

        const formData = new FormData(form);

        try {
            const response = await fetch('/api/bookings', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (response.ok) {
                alert('تم تسجيل البيانات بنجاح!');
                form.reset();
            } else {
                alert('حدث خطأ: ' + (result.message || 'فشل حفظ البيانات'));
            }
        } catch (error) {
            console.error('Error submitting form:', error);
            alert('تعذر الاتصال بالسيرفر. يرجى المحاولة لاحقاً.');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'حفظ الحجز / البيانات';
        }
    });
}

// 3. البحث عن المواعيد والبيانات
function setupSearchForm() {
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');

    if (!searchBtn || !searchInput) return;

    searchBtn.addEventListener('click', performSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') performSearch();
    });

    async function performSearch() {
        const query = searchInput.value.trim();
        if (!query) {
            alert('يرجى إدخال كلمة للبحث');
            return;
        }

        searchResults.innerHTML = '<p style="text-align:center; padding: 20px;">جاري البحث...</p>';

        try {
            const response = await fetch(`/api/bookings/search?q=${encodeURIComponent(query)}`);
            const data = await response.json();

            if (response.ok && data.length > 0) {
                renderSearchResults(data);
            } else {
                searchResults.innerHTML = '<p style="text-align:center; padding: 20px; color: var(--secondary-color);">لم يتم العثور على نتائج متطابقة.</p>';
            }
        } catch (error) {
            console.error('Error fetching search results:', error);
            searchResults.innerHTML = '<p style="text-align:center; padding: 20px; color: red;">حدث خطأ أثناء البحث.</p>';
        }
    }
}

// عرض نتائج البحث
function renderSearchResults(items) {
    const searchResults = document.getElementById('search-results');
    searchResults.innerHTML = items.map(item => `
        <div class="result-card">
            <h3>${item.patient_name || 'بدون اسم'}</h3>
            <p><strong>رقم الهاتف:</strong> ${item.phone || '-'}</p>
            <p><strong>الموعد:</strong> ${item.appointment_date || '-'}</p>
            <p><strong>التشخيص:</strong> ${item.diagnosis || '-'}</p>
            <p><strong>ملاحظات:</strong> ${item.notes || '-'}</p>
            ${item.attachment_url ? `<a href="${item.attachment_url}" target="_blank" class="file-link">📁 عرض / تنزيل المرفق</a>` : ''}
        </div>
    `).join('');
}

// 4. زر تحميل النسخة الاحتياطية (Backup Zip)
function setupBackupButton() {
    const backupBtn = document.getElementById('download-backup-btn');
    if (!backupBtn) return;

    backupBtn.addEventListener('click', () => {
        backupBtn.disabled = true;
        backupBtn.textContent = 'جاري إعداد ملف الـ ZIP...';

        window.location.href = '/api/admin/backup';

        setTimeout(() => {
            backupBtn.disabled = false;
            backupBtn.textContent = 'تنزيل نسخة احتياطية (ZIP)';
        }, 4000);
    });
}
