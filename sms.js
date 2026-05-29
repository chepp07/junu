const axios = require('axios');
const crypto = require('crypto');

/* ── 환경변수 ── */
const API_KEY    = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const SENDER     = process.env.SOLAPI_SENDER;
const DB_URL     = process.env.FIREBASE_DB_URL;
const EVENT_DATE = process.env.EVENT_DATE || '2026-05-31';

/* ── 테스트 모드 ── */
const TEST_MODE  = process.env.TEST_MODE === 'true';
const TEST_PHONE = process.env.TEST_PHONE || '';

if (TEST_MODE) {
  console.log('========================================');
  console.log('🧪 테스트 모드 실행 중');
  console.log(`📱 모든 SMS → ${TEST_PHONE} 으로만 발송`);
  console.log(`📅 오늘 날짜를 행사 날짜로 사용`);
  console.log('========================================\n');
}

function getSolapiAuth() {
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 22);
  const hmac = crypto.createHmac('sha256', API_SECRET);
  hmac.update(date + salt);
  const sig = hmac.digest('hex');
  return `HMAC-SHA256 apiKey=${API_KEY}, date=${date}, salt=${salt}, signature=${sig}`;
}

async function sendSMS(to, name, slotTime) {
  const receiver = TEST_MODE ? TEST_PHONE : to;
  let text;
  if (TEST_MODE) {
    text = `[드림교회]헌혈알림\n${name}(${slotTime}) 도착10분전\n백영고운동장 헌혈차량앞\n※신분증지참 [TEST:${to}]`;
  } else {
    text = `[드림교회]헌혈알림\n${name}님(${slotTime}) 도착10분전\n백영고운동장 헌혈차량앞\n※신분증필수지참`;
  }
  try {
    const res = await axios.post(
      'https://api.solapi.com/messages/v4/send',
      { message: { to: receiver.replace(/-/g,''), from: SENDER.replace(/-/g,''), text, type:'SMS' } },
      { headers: { Authorization: getSolapiAuth(), 'Content-Type':'application/json' } }
    );
    console.log(`  ✅ 발송 성공: ${name} (${to})`);
    return res.data;
  } catch (err) {
    console.error(`  ❌ 발송 실패 (${to}):`, err.response?.data || err.message);
    return null;
  }
}

async function getSlots() {
  try {
    console.log(`Firebase URL: ${DB_URL}`);
    const res = await axios.get(`${DB_URL}/slots.json`);
    const data = res.data || {};
    console.log(`Firebase 읽기 성공: 슬롯 ${Object.keys(data).length}개`);
    return data;
  } catch (err) {
    console.error('❌ Firebase 읽기 실패:', err.message);
    console.error('   상태코드:', err.response?.status);
    return {};
  }
}

async function markSMSSent(slotKey, entryKey) {
  try {
    await axios.patch(`${DB_URL}/slots/${slotKey}/entries/${entryKey}.json`, { smsSent: true });
  } catch (err) {
    console.error(`smsSent 업데이트 실패:`, err.message);
  }
}

async function main() {
  const now   = new Date();
  const slots = await getSlots();
  let sentCount = 0;

  console.log(`현재 시각: ${now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n`);

  for (const [slotKey, slotData] of Object.entries(slots)) {
    const entries = slotData.entries || {};
    for (const [entryKey, entry] of Object.entries(entries)) {
      if (entry.smsSent === true || entry.smsSent === 'true') continue;
      if (entry.status === '취소') continue;
      if (!entry.phone || !entry.slot) continue;

      if (TEST_MODE) {
        const n = (entry.name || '').toLowerCase();
        if (n !== '테스트' && n !== 'test') continue;
      }

      const [hh, mm] = entry.slot.split(':').map(Number);
      const baseDate = TEST_MODE
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
        : new Date(`${EVENT_DATE}T00:00:00+09:00`);
      baseDate.setHours(hh, mm, 0, 0);

      const sendTime = new Date(baseDate.getTime() - 20 * 60 * 1000);
      const diffMin  = (sendTime.getTime() - now.getTime()) / 60000;

      console.log(`[${entry.name}] 슬롯: ${entry.slot} | 발송예정: ${sendTime.toLocaleTimeString('ko-KR')} | 남은시간: ${diffMin.toFixed(1)}분`);

      if (diffMin >= -5 && diffMin <= 10) {
        console.log(`  → 발송 조건 충족!`);
        const result = await sendSMS(entry.phone, entry.name, entry.slot);
        if (result) {
          if (!TEST_MODE) await markSMSSent(slotKey, entryKey);
          else console.log(`  [테스트] smsSent 생략`);
          sentCount++;
        }
      }
    }
  }
  console.log(`\n완료: 총 ${sentCount}건 발송${TEST_MODE ? ' (테스트 모드)' : ''}`);
}

main().catch(console.error);
