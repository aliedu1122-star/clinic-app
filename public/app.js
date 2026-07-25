// المتغيرات العامة
let currentTab = 'new-booking';
let currentSearchType = 'phone';

// عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', () => {
    // إعداد التبديل بين التبويبات
    setupTabs();
    
    // إعداد نموذج الحجز الجديد
    setupBookingForm();
    
    // إعداد نموذج البحث
    setupSearchForm();
    
    // إعداد زر النسخ الاحتياطي
    setupBackupButton();
});

// 1. التبديل بين الشاشات (التبويبات)
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
                alert('تم تسجيل الحجز بنجاح!');
                form.reset();
            } else {
                alert('حدث خطأ: ' + (result.message || 'فشل حفظ البيانات'));
            }
        } catch (error) {
            console.error('Error submitting form:', error);
            alert('تعذر الاتصال بالسيرفر. يرجى المحاولة لاحقاً.');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'حفظ الحجز';
        }
    });
}

// 3. البحث عن المواعيد والبيانات
function setupSearchForm() {
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');

    if (!searchBtn || !searchInput) return;

    searchBtn.addEventListener('click', async () => {
        const query = searchInput.value.trim();
        if (!query) {
            alert('يرجى إدخال كلمة للبحث');
            return;
        }

        searchResults.innerHTML = '<p class="loading">جاري البحث...</p>';

        try {
            const response = await fetch(`/api/bookings/search?q=${encodeURIComponent(query)}`);
            const data = await response.json();

            if (response.ok && data.length > 0) {
                renderSearchResults(data);
            } else {
                searchResults.innerHTML = '<p class="no-results">لم يتم العثور على نتائج matching.</p>';
            }
        } catch (error) {
            console.error('Error fetching search results:', error);
            searchResults.innerHTML = '<p class="error">حدث خطأ أثناء البحث.</p>';
        }
    });
}

// عرض نتائج البحث
function renderSearchResults(items) {
    const searchResults = document.getElementById('search-results');
    searchResults.innerHTML = items.map(item => `
        <div class="result-card">
            <h3>${item.patient_name || 'بدون اسم'}</h3>
            <p><strong>رقم الهاتف:</strong> ${item.phone || '-'}</p>
            <p><strong>الموعد:</strong> ${item.appointment_date || '-'}</p>
            <p><strong>ملاحظات:</strong> ${item.notes || '-'}</p>
            ${item.attachment_url ? `<a href="${item.attachment_url}" target="_blank" class="file-link">عرض المرفق</a>` : ''}
        </div>
    `).join('');
}

// 4. زر تحميل النسخة الاحتياطية (Backup Zip)
function setupBackupButton() {
    const backupBtn = document.getElementById('download-backup-btn');
    if (!backupBtn) return;

    backupBtn.addEventListener('click', async () => {
        backupBtn.disabled = true;
        backupBtn.textContent = 'جاري التجهيز...';

        try {
            window.location.href = '/api/admin/backup';
        } catch (error) {
            alert('فشل تحميل النسخة الاحتياطية.');
        } finally {
            setTimeout(() => {
                backupBtn.disabled = false;
                backupBtn.textContent = 'تنزيل نسخة احتياطية (ZIP)';
            }, 3000);
        }
    });
}
