const axios = require('axios');
const crypto = require('crypto');

/* ── 환경변수 ── */
const API_KEY    = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const SENDER     = process.env.SOLAPI_SENDER;
const DB_URL     = process.env.FIREBASE_DB_URL;
const EVENT_DATE = process.env.EVENT_DATE || '2026-05-31'; // 행사 날짜 (YYYY-MM-DD)

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

/* ── 솔라피 인증 헤더 생성 ── */
function getSolapiAuth() {
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 22);
  const hmac = crypto.createHmac('sha256', API_SECRET);
  hmac.update(date + salt);
  const sig = hmac.digest('hex');
  return `HMAC-SHA256 apiKey=${API_KEY}, date=${date}, salt=${salt}, signature=${sig}`;
}

/* ── SMS 발송 함수 ── */
async function sendSMS(to, name, slotTime) {
  // 테스트 모드: 수신번호를 테스트 번호로 교체
  const receiver = TEST_MODE ? TEST_PHONE : to;

  const text =
    `[평촌드림교회] 헌혈 예약 알림\n` +
    `${name}님, 헌혈 예약 시간(${slotTime}) 10분 전 도착 부탁드립니다.\n` +
    `지금 백영고 운동장 헌혈 차량 앞으로 이동해 주세요.\n` +
    `※ 신분증 필수 지참` +
    (TEST_MODE ? `\n[테스트 발송 - 원래 수신자: ${to} / ${name}]` : '');

  try {
    const res = await axios.post(
      'https://api.solapi.com/messages/v4/send',
      {
        message: {
          to:   receiver.replace(/-/g, ''),
          from: SENDER.replace(/-/g, ''),
          text: text,
          type: 'SMS',
        },
      },
      {
        headers: {
          Authorization: getSolapiAuth(),
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`  ✅ 발송 성공: ${name} (${to}) → 슬롯 ${slotTime}`);
    return res.data;
  } catch (err) {
    console.error(`  ❌ 발송 실패 (${to}):`, err.response?.data || err.message);
    return null;
  }
}

/* ── Firebase REST API로 슬롯 데이터 읽기 ── */
async function getSlots() {
  try {
    const res = await axios.get(`${DB_URL}/slots.json`);
    return res.data || {};
  } catch (err) {
    console.error('Firebase 읽기 실패:', err.message);
    return {};
  }
}

/* ── Firebase smsSent 플래그 업데이트 ── */
async function markSMSSent(slotKey, entryKey) {
  try {
    await axios.patch(
      `${DB_URL}/slots/${slotKey}/entries/${entryKey}.json`,
      { smsSent: true }
    );
  } catch (err) {
    console.error(`smsSent 업데이트 실패 (${entryKey}):`, err.message);
  }
}

/* ── 메인 실행 ── */
async function main() {
  const now   = new Date();
  const slots = await getSlots();
  let sentCount = 0;

  console.log(`현재 시각: ${now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n`);

  for (const [slotKey, slotData] of Object.entries(slots)) {
    const entries = slotData.entries || {};

    for (const [entryKey, entry] of Object.entries(entries)) {

      /* 이미 발송했거나 취소된 신청 건너뜀 */
      if (entry.smsSent)           continue;
      if (entry.status === '취소')  continue;
      if (!entry.phone || !entry.slot) continue;

      /* 예약 시간 파싱 — "09:00" 형식 */
      const [hh, mm] = entry.slot.split(':').map(Number);

      /*
       * 테스트 모드: 오늘 날짜 기준으로 예약 시간 계산
       * 실제 모드: 행사 날짜(EVENT_DATE) 기준
       */
      const baseDate = TEST_MODE
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
        : new Date(`${EVENT_DATE}T00:00:00+09:00`);

      baseDate.setHours(hh, mm, 0, 0);

      /*
       * 발송 타이밍 계산:
       * 헌혈 시간 = slotTime
       * 도착 시간 = slotTime - 10분
       * 발송 시간 = 도착 시간 - 10분 = slotTime - 20분
       *
       * 예) 헌혈 09:00 → 도착 08:50 → 발송 08:40
       */
      const sendTime = new Date(baseDate.getTime() - 20 * 60 * 1000);
      const diffMin  = (sendTime.getTime() - now.getTime()) / 60000;

      console.log(
        `[${entry.name}] 슬롯: ${entry.slot} | ` +
        `발송 예정: ${sendTime.toLocaleTimeString('ko-KR')} | ` +
        `남은 시간: ${diffMin.toFixed(1)}분`
      );

      /*
       * 발송 조건:
       * diffMin이 -2 ~ +5 범위 (스케줄러 5분 간격 기준, ±여유 포함)
       * 즉 발송 예정 시각 ±5분 이내에 실행될 경우 발송
       */
      if (diffMin >= -2 && diffMin <= 5) {
        console.log(`  → 발송 조건 충족!`);
        const result = await sendSMS(entry.phone, entry.name, entry.slot);

        if (result) {
          // 테스트 모드에서는 smsSent를 true로 바꾸지 않음 (재발송 가능하도록)
          if (!TEST_MODE) {
            await markSMSSent(slotKey, entryKey);
          } else {
            console.log(`  [테스트] smsSent 업데이트 생략 (재테스트 가능)`);
          }
          sentCount++;
        }
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`완료: 총 ${sentCount}건 발송${TEST_MODE ? ' (테스트 모드)' : ''}`);
  console.log(`========================================`);
}

main().catch(console.error);
