// Fee Service — bản NGÂY THƠ (trước khi sửa), dùng để đo số liệu "trước".
// Lỗi cố ý: không timeout, mỗi lời gọi một kết nối TCP mới, không thử lại, không Idempotency-Key,
// lỗi kết nối làm sập tiến trình (unhandled rejection).
const express = require('express');
const http = require('http');

const PORT = Number(process.env.PORT || 4001);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';

const students = new Map([
  ['1', { id: '1', balance: 50_000_000 }],
  ['2', { id: '2', balance: 0 }],
  ['3', { id: '3', balance: 3_200_000 }],
]);
let seq = 0;

function postCharge(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(new URL('/charges', BANK_URL), {
      method: 'POST',
      agent: false, // mỗi yêu cầu mở kết nối mới
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const app = express();
app.use(express.json());

app.get('/students/:id/fees', (req, res) => {
  const s = students.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ studentId: s.id, balance: s.balance });
});

app.post('/students/:id/payments', async (req, res) => {
  const s = students.get(req.params.id);
  const { amount } = req.body;
  if (amount > s.balance) return res.status(400).json({ error: 'Vượt công nợ' });
  const id = 'P' + ++seq;
  const r = await postCharge({ reference: id, amount }); // lỗi ở đây => sập
  if (r.status === 201) {
    s.balance -= amount;
    return res.status(201).json({ paymentId: id, status: 'PAID', balance: s.balance });
  }
  res.status(r.status).json({ error: r.body.error, paymentId: id, status: 'FAILED' });
});

app.listen(PORT, () => console.log(`[fee-naive] cổng ${PORT} | BANK_URL=${BANK_URL}`));
