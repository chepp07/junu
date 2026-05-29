const axios = require('axios');
const crypto = require('crypto');

const API_KEY    = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const SENDER     = process.env.SOLAPI_SENDER;
const DB_URL     = process.env.FIREBASE_DB_URL;
const EVENT_DATE = process.env.EVENT_DATE || '2026-05-31';
const TEST_MODE  = process.env.TEST_MODE === 'true';
const TEST_PHONE = process.env.TEST_PHONE || '';

if (TEST_MODE) {
  console.log('=== 테스트 모드 ===');
  console.log('수신번호:', TEST_PHONE);
}

function getSolapiAuth() {
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 22);
  const hmac = crypto.createHmac('sha256', API_SECRET);
  hmac.update(date + salt);
  return `HMAC-SHA256 apiKey=${API_KEY}, date=${date}, salt=${salt}, signature=${hmac.digest('hex')}`;
}

async function sendSMS(to, name, slotTime) {
  const receiver = TEST_MODE ? TEST_PHONE : to;
  const text = TEST_MODE
    ? `[드림교회]헌혈알림\n${name}(${slotTime}) 도착10분전\n백영고운동장 헌혈차량앞\n※신분증지참`
    : `[드림교회]헌혈알림\n${name}님(${slotTime}) 도착10분전\n백영고운동장 헌혈차량앞\n※신분증필수지참`;
  try {
    await axios.post(
      'https://api.solapi.com/messages/v4/send',
      { message: { to: receiver.replace(/-/g,''), from: SENDER.replace(/-/g,''), text, type:'SMS' } },
      { headers: { Authorization: getSolapiAuth(), 'Content-Type':'application/json' } }
    );
    console.log(`발송성공: ${name} ${to} ${slotTime}`);
    return true;
  } catch (err) {
    console.error(`발송실패: ${to}`, JSON.stringify(err.response?.data || err.message));
    return false;
  }
}

async function markSMSSent(slotKey, entryKey) {
  try {
    await axios.patch(`${DB_URL}/slots/${slotKey}/entries/${entryKey}.json`, { smsSent: true });
  } catch (err) {
    console.error('smsSent업데이트실패:', err.message);
  }
}

async function main() {
  const now = new Date();
  console.log('현재시각:', now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));

  const res = await axios.get(`${DB_URL}/slots.json`).catch(e => { console.error('DB읽기실패:', e.message); return null; });
  if (!res) return;

  const slots = res.data || {};
  console.log('슬롯키목록:', Object.keys(slots).join(','));

  let sentCount = 0;

  for (const [slotKey, slotData] of Object.entries(slots)) {
    if (!slotData || typeof slotData !== 'object') continue;
    const entries = slotData.entries || {};
    console.log(`슬롯${slotKey} entries수:`, Object.keys(entries).length);

    for (const [entryKey, entry] of Object.entries(entries)) {
      console.log(`  entry:`, entry.name, entry.slot, entry.smsSent, entry.status);

      if (entry.smsSent === true || entry.smsSent === 'true') continue;
      if (entry.status === '취소') continue;
      if (!entry.phone || !entry.slot) continue;
      if (TEST_MODE && !['test','테스트'].includes((entry.name||'').toLowerCase())) continue;

      const [hh, mm] = entry.slot.split(':').map(Number);
      const base = TEST_MODE
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0)
        : new Date(`${EVENT_DATE}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+09:00`);

      const sendTime = new Date(base.getTime() - 20 * 60 * 1000);
      const diff = (sendTime.getTime() - now.getTime()) / 60000;
      console.log(`  발송예정:`, sendTime.toLocaleTimeString('ko-KR'), `남은:${diff.toFixed(1)}분`);

      if (diff >= -5 && diff <= 10) {
        const ok = await sendSMS(entry.phone, entry.name, entry.slot);
        if (ok) {
          if (!TEST_MODE) await markSMSSent(slotKey, entryKey);
          sentCount++;
        }
      }
    }
  }
  console.log(`완료: ${sentCount}건 발송`);
}

main().catch(console.error);
