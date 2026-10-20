// Ngân hàng giả lập — cổng 4002
// Biến môi trường: PORT, DELAY_MS, FAIL_RATE, DROP_RATE
const express = require('express');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4002);
const DELAY_MS = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);
const DROP_RATE = Number(process.env.DROP_RATE || 0);
const LIMIT = 20_000_000;

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const chargedReferences = new Set();
const byIdempotencyKey = new Map(); // key -> { status, body } (kết quả đã chốt)
const inFlight = new Map(); // key -> Promise (yêu cầu cùng khóa đang xử lý)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(express.json());

app.get('/stats', (req, res) => res.json(stats));

app.post('/charges', async (req, res) => {
  stats.requests++;
  const key = req.get('Idempotency-Key');
  const { reference, amount } = req.body || {};

  if (DELAY_MS > 0) await sleep(DELAY_MS);

  // Cùng khóa đang được xử lý ở yêu cầu khác: chờ yêu cầu đó xong.
  while (key && inFlight.has(key)) await inFlight.get(key);

  if (key && byIdempotencyKey.has(key)) {
    const saved = byIdempotencyKey.get(key);
    res.set('Idempotent-Replayed', 'true');
    return res.status(saved.status).json(saved.body);
  }

  let done;
  if (key) inFlight.set(key, new Promise((r) => (done = r)));
  try {
    if (typeof reference !== 'string' || !reference || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Số tiền hoặc reference không hợp lệ' });
    }

    // Lỗi tạm thời: trả 500 TRƯỚC khi trừ tiền, không lưu theo khóa để có thể thử lại.
    if (Math.random() < FAIL_RATE) {
      return res.status(500).json({ error: 'Lỗi hệ thống ngân hàng (tạm thời)' });
    }

    if (amount > LIMIT) {
      const result = { status: 402, body: { error: 'Vượt hạn mức 20.000.000đ', reference, amount } };
      if (key) byIdempotencyKey.set(key, result);
      return res.status(result.status).json(result.body);
    }

    // Trừ tiền
    if (chargedReferences.has(reference)) stats.duplicates++;
    chargedReferences.add(reference);
    stats.charges++;
    const result = {
      status: 201,
      body: { chargeId: 'CH-' + crypto.randomUUID().slice(0, 8), reference, amount, status: 'SUCCEEDED' },
    };
    if (key) byIdempotencyKey.set(key, result);

    // Đã trừ tiền rồi cắt kết nối, không trả lời.
    if (Math.random() < DROP_RATE) {
      console.log(`[bank] DROP sau khi trừ tiền ${reference}`);
      return req.socket.destroy();
    }
    return res.status(result.status).json(result.body);
  } finally {
    if (key) {
      inFlight.delete(key);
      done();
    }
  }
});

const server = app.listen(PORT, () => {
  console.log(`[bank] cổng ${PORT} | DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE}`);
});
server.keepAliveTimeout = 5000; // mặc định của Node.js, ghi rõ ra
server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[bank] kết nối TCP mới #${stats.connections} từ ${socket.remotePort}`);
});
