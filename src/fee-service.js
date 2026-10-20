// Fee Service — cổng 4001 (bản đã sửa)
// Biến môi trường: PORT, BANK_URL, BANK_DEADLINE_MS, CONNECT_TIMEOUT_MS, RECONCILE_MS
const express = require('express');
const crypto = require('crypto');
const { createBankClient } = require('./bank-client');

const PORT = Number(process.env.PORT || 4001);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const RECONCILE_MS = Number(process.env.RECONCILE_MS || 10000);
const RECONCILE_DEADLINE_MS = Number(process.env.RECONCILE_DEADLINE_MS || 15000);

// Mỗi lần khởi động có một mã riêng để reference/khóa không trùng với lần chạy trước
// (ngân hàng vẫn nhớ P1 của lần chạy cũ).
const INSTANCE = crypto.randomUUID().slice(0, 6);

const bank = createBankClient({
  baseUrl: BANK_URL,
  deadlineMs: Number(process.env.BANK_DEADLINE_MS || 4000),
  connectTimeoutMs: Number(process.env.CONNECT_TIMEOUT_MS || 1000),
});

const students = new Map([
  ['1', { id: '1', balance: 50_000_000 }],
  ['2', { id: '2', balance: 0 }],
  ['3', { id: '3', balance: 3_200_000 }],
]);
const payments = new Map();
let seq = 0;

// Tiền của các lệnh chưa chốt (đang gọi/PENDING) được giữ chỗ để không thanh toán vượt công nợ.
const reserved = (studentId) =>
  [...payments.values()]
    .filter((p) => p.studentId === studentId && (p.status === 'PROCESSING' || p.status === 'PENDING'))
    .reduce((s, p) => s + p.amount, 0);

function markPaid(p, body) {
  if (p.status === 'PAID') return;
  p.status = 'PAID';
  p.chargeId = body.chargeId;
  students.get(p.studentId).balance -= p.amount; // chỉ giảm khi ngân hàng đã trừ tiền
}

const view = (p) => ({
  paymentId: p.id,
  studentId: p.studentId,
  amount: p.amount,
  status: p.status,
  chargeId: p.chargeId,
  balance: students.get(p.studentId).balance,
});

const app = express();
app.use(express.json());

app.get('/students/:id/fees', (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  res.json({ studentId: s.id, balance: s.balance, reserved: reserved(s.id) });
});

app.get('/payments/:id', (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Không tìm thấy lệnh thanh toán' });
  res.json(view(p));
});

app.get('/payments', (req, res) => {
  const list = [...payments.values()];
  const count = (st) => list.filter((p) => p.status === st).length;
  res.json({ total: list.length, PAID: count('PAID'), PENDING: count('PENDING'), FAILED: count('FAILED') });
});

app.post('/students/:id/payments', async (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  const amount = req.body && req.body.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Số tiền phải là số nguyên dương' });
  }
  if (amount > s.balance - reserved(s.id)) {
    return res.status(400).json({ error: 'Số tiền vượt công nợ', balance: s.balance, reserved: reserved(s.id) });
  }

  const id = 'P' + ++seq;
  const p = { id, studentId: s.id, amount, status: 'PROCESSING', reference: `${INSTANCE}-${id}`, createdAt: Date.now() };
  payments.set(id, p);

  const r = await bank.charge({ reference: p.reference, amount, idempotencyKey: p.reference });

  switch (r.outcome) {
    case 'PAID':
      markPaid(p, r.body);
      return res.status(201).json(view(p));
    case 'REJECTED': // ngân hàng từ chối rõ ràng: giữ mã của ngân hàng
      p.status = 'FAILED';
      return res.status(r.httpStatus).json({ error: r.body?.error || 'Ngân hàng từ chối', paymentId: id, status: p.status });
    case 'NOT_CHARGED': // chắc chắn chưa trừ tiền
      p.status = 'FAILED';
      return res.status(503).json({ error: `Không kết nối được tới ngân hàng: ${r.reason}`, paymentId: id, status: p.status });
    default: // UNKNOWN: không biết đã trừ hay chưa
      p.status = 'PENDING';
      return res.status(504).json({ error: `Chưa xác định kết quả từ ngân hàng: ${r.reason}`, paymentId: id, status: p.status });
  }
});

// Đối soát nền: gửi lại lệnh PENDING với CÙNG Idempotency-Key — ngân hàng trả giao dịch cũ
// nếu đã trừ, nên không bao giờ trừ hai lần.
async function reconcile() {
  for (const p of payments.values()) {
    if (p.status !== 'PENDING') continue;
    // Không có sinh viên đang chờ nên cho phép chờ lâu hơn (ngân hàng chậm vẫn đối soát được).
    const r = await bank.charge({ reference: p.reference, amount: p.amount, idempotencyKey: p.reference, deadlineMs: RECONCILE_DEADLINE_MS });
    if (r.outcome === 'PAID') markPaid(p, r.body);
    else if (r.outcome === 'REJECTED') p.status = 'FAILED';
    if (p.status !== 'PENDING') console.log(`[fee] đối soát ${p.id} -> ${p.status}`);
  }
}
if (RECONCILE_MS > 0) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await reconcile(); } finally { running = false; }
  }, RECONCILE_MS).unref();
}

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON không hợp lệ' });
  console.error(err);
  res.status(500).json({ error: 'Lỗi nội bộ' });
});

app.listen(PORT, () => console.log(`[fee] cổng ${PORT} | BANK_URL=${BANK_URL} | instance ${INSTANCE}`));
