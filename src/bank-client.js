// HTTP client gọi ngân hàng: keep-alive, timeout, thử lại an toàn nhờ Idempotency-Key.
const http = require('http');
const https = require('https');

// Lỗi xảy ra trước khi kết nối được => chắc chắn yêu cầu chưa tới ngân hàng.
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CONNECT_TIMEOUT']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createBankClient({ baseUrl, deadlineMs = 4000, connectTimeoutMs = 1000, maxAttempts = 5 }) {
  const url = new URL('/charges', baseUrl);
  const lib = url.protocol === 'https:' ? https : http;
  // Tái sử dụng kết nối TCP. Đóng kết nối rảnh sau 4s, trước khi ngân hàng tự đóng ở 5s,
  // để không gửi yêu cầu lên một socket sắp bị đóng.
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20, timeout: 4000 });

  // Một lần gửi. Trả về { kind: 'response' | 'connect_error' | 'error' | 'timeout', ... }
  function attempt(payload, idempotencyKey, timeLeftMs) {
    return new Promise((resolve) => {
      const data = JSON.stringify(payload);
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(connectTimer);
        resolve(r);
      };
      let connectTimer;
      const req = lib.request(url, {
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Idempotency-Key': idempotencyKey,
        },
      });
      const deadline = setTimeout(() => {
        finish({ kind: 'timeout' });
        req.destroy();
      }, timeLeftMs);
      req.on('socket', (socket) => {
        if (socket.connecting) {
          connectTimer = setTimeout(() => {
            finish({ kind: 'connect_error', code: 'CONNECT_TIMEOUT' });
            req.destroy();
          }, connectTimeoutMs);
          socket.once('connect', () => clearTimeout(connectTimer));
        }
      });
      req.on('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* bỏ qua */ }
          finish({ kind: 'response', status: res.statusCode, body: json });
        });
        res.on('error', (e) => finish({ kind: 'error', code: e.code || e.message }));
      });
      req.on('error', (e) => {
        if (CONNECT_ERRORS.has(e.code)) finish({ kind: 'connect_error', code: e.code });
        else finish({ kind: 'error', code: e.code || e.message, reusedSocket: req.reusedSocket });
      });
      req.end(data);
    });
  }

  // Kết quả: PAID | REJECTED (4xx) | NOT_CHARGED (chắc chắn chưa trừ) | UNKNOWN (có thể đã trừ)
  async function charge({ reference, amount, idempotencyKey, deadlineMs: budgetMs = deadlineMs }) {
    const start = Date.now();
    let maybeCharged = false; // đã có lần nào mà yêu cầu có thể đã tới ngân hàng chưa?
    let last = 'unknown';
    for (let i = 0; i < maxAttempts; i++) {
      const timeLeft = budgetMs - (Date.now() - start);
      if (timeLeft <= 50) break;
      const r = await attempt({ reference, amount }, idempotencyKey, timeLeft);

      if (r.kind === 'response') {
        if (r.status >= 200 && r.status < 300) return { outcome: 'PAID', body: r.body };
        if (r.status >= 400 && r.status < 500) return { outcome: 'REJECTED', httpStatus: r.status, body: r.body };
        last = `ngân hàng trả ${r.status}`; // 5xx: lỗi tạm thời -> thử lại
      } else if (r.kind === 'connect_error') {
        // Không kết nối được: thử lại lúc này cũng vô ích, trả lời nhanh.
        return maybeCharged ? { outcome: 'UNKNOWN', reason: r.code } : { outcome: 'NOT_CHARGED', reason: r.code };
      } else if (r.kind === 'timeout') {
        // Ngân hàng chậm: hết ngân sách thời gian, không thử lại.
        return { outcome: 'UNKNOWN', reason: `quá ${budgetMs}ms không có phản hồi` };
      } else {
        // Đứt kết nối giữa chừng (ECONNRESET / socket hang up): có thể đã trừ tiền.
        // Thử lại an toàn vì có Idempotency-Key.
        maybeCharged = true;
        last = `đứt kết nối (${r.code})`;
        if (r.reusedSocket && i === 0) continue; // socket keep-alive cũ vừa bị đóng: thử lại ngay
      }
      await sleep(Math.min(100 * 2 ** i, 800) * (0.5 + Math.random() / 2));
    }
    return maybeCharged ? { outcome: 'UNKNOWN', reason: last } : { outcome: 'NOT_CHARGED', reason: last };
  }

  return { charge, agent };
}

module.exports = { createBankClient };
