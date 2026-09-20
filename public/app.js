const chat = document.querySelector('#chat'); const input = document.querySelector('#input'); const send = document.querySelector('#send'); const status = document.querySelector('#status'); const login = document.querySelector('#login'); let csrf = '';
function add(role, text, meta = '') { const el = document.createElement('div'); el.className = msg ${role}; el.textContent = text; if (meta) { const m = document.createElement('small'); m.textContent = meta; el.appendChild(m); } chat.appendChild(el); chat.scrollTop = chat.scrollHeight; return el; }
async function api(url, opt = {}) { const r = await fetch(url, opt); let data = {}; try { data = await r.json(); } catch {} if (!r.ok) throw new Error(data.error || خطای ${r.status}); return data; }
async function load() { try { const me = await api('/api/me');
if (!me.authenticated) {
  login.style.display = 'grid';
  return;
}

csrf = me.csrf || '';

const history = await api('/api/history');
history.forEach(x => add(x.role, x.content));

const h = await api('/api/health');
status.textContent = h.providers.length
  ? `متصل · ${h.providers.length} مدل`
  : 'آماده · بدون مدل خارجی';

input.focus();
} catch (e) { status.textContent = 'هسته آماده نیست'; } }
document.querySelector('#loginBtn').onclick = async () => { const b = document.querySelector('#loginBtn'); const err = document.querySelector('#loginErr');
b.disabled = true; err.textContent = '';
try { const result = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.querySelector('#password').value }) });
csrf = result.csrf || '';
login.style.display = 'none';
load();
} catch (e) { err.textContent = e.message; } finally { b.disabled = false; } };
document.querySelector('#password').onkeydown = e => { if (e.key === 'Enter') { document.querySelector('#loginBtn').click(); } };
document.querySelector('#logout').onclick = async () => { await api('/api/logout', { method: 'POST', headers: { 'X-HOMA-CSRF': csrf } }); location.reload(); };
document.querySelector('#form').onsubmit = async e => { e.preventDefault();
const text = input.value.trim(); if (!text || send.disabled) return;
add('user', text); input.value = ''; send.disabled = true; status.textContent = 'هما داره فکر می‌کنه…';
const typing = add('assistant', 'در حال فکر کردن…'); typing.classList.add('typing');
try { const j = await api('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HOMA-CSRF': csrf }, body: JSON.stringify({ message: text }) });
typing.remove();

add(
  'assistant',
  j.reply,
  j.agents?.length > 1 ? جمع‌بندی ${j.agents.length} عامل : ''
);

status.textContent = j.connected
  ? متصل · ${j.agents?.length || 1} مدل
  : 'بدون مدل خارجی';
} catch (e) { typing.remove(); add('assistant', 'خطا: ' + e.message); status.textContent = 'خطا'; } finally { send.disabled = false; input.focus(); } };
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.querySelector('#form').requestSubmit(); } });
document.querySelector('#clear').onclick = async () => { if (confirm('گفتگو پاک شود؟')) { await api('/api/clear', { method: 'POST', headers: { 'X-HOMA-CSRF': csrf } }); chat.innerHTML = ''; } };
load();
if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker .register('/sw.js') .catch(() => {}); }); }
