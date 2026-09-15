# HOMA Web — v5.3 Team Edition

وب‌اپ سبک و امن برای گفت‌وگوی مدیر پروژه با تیم چندعاملی HOMA.

## تیم AI
HOMA می‌تواند به‌صورت همزمان از OpenAI، Anthropic، Gemini و یک endpoint سازگار با OpenAI استفاده کند. هر کلید فقط روی سرور نگهداری می‌شود. پاسخ‌ها مستقل گرفته و توسط مدل اصلی به یک پاسخ کوتاه و عملی تبدیل می‌شوند.

این «یادگیری» به معنای حافظه/بازخورد کنترل‌شده است؛ مدل‌ها خودسرانه به حساب‌های دیگر یا داده‌های خصوصی وصل نمی‌شوند.

## اجرا
1. `.env.example` را به `.env` تبدیل کنید و کلیدها را روی سرور تنظیم کنید.
2. `npm install`
3. `npm start`
4. پشت HTTPS و reverse proxy اجرا شود.

## امنیت
- Session token تصادفی و فقط hash آن در SQLite ذخیره می‌شود.
- Cookie: HttpOnly + Secure در production + SameSite=Strict.
- CSRF token برای عملیات تغییردهنده.
- Rate limiting برای login و chat.
- CSP، HSTS، X-Frame-Options، nosniff و no-referrer.
- APIهای تاریخچه و گفتگو نیازمند احراز هویت‌اند.
- هیچ API key در frontend ارسال نمی‌شود.

> «غیرقابل نفوذ» تضمین‌پذیر نیست؛ هدف، دفاع چندلایه و کمینه‌کردن سطح حمله است.
