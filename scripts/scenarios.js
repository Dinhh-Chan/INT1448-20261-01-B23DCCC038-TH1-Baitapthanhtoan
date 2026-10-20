// Chạy 4 tình huống và in số liệu.
// Dùng: node scripts/scenarios.js [fixed|naive] [1 2 3 4]
const { spawn } = require('child_process');
const path = require('path');

const variant = process.argv[2] || 'fixed';
const only = process.argv.slice(3).map(Number);
const FEE_FILE = path.join(__dirname, '..', 'src', variant === 'naive' ? 'fee-service.naive.js' : 'fee-service.js');
const BANK_FILE = path.join(__dirname, '..', 'src', 'bank.js');
const FEE = 'http://localhost:4001';
const BANK = 'http://localhost:4002';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set();

function start(file, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.add(p);
    p.log = '';
    p.alive = true;
    p.on('exit', () => { p.alive = false; procs.delete(p); });
    const onData = (d) => {
      p.log += d;
      if (p.log.includes('cổng')) resolve(p);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => (p.log += d));
    setTimeout(() => reject(new Error('không khởi động được ' + file + '\n' + p.log)), 5000);
  });
}
function stop(p) {
  if (!p || !p.alive) return Promise.resolve();
  return new Promise((r) => { p.once('exit', r); p.kill(); });
}

async function call(method, url, body) {
  const t = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, ms: Date.now() - t };
  } catch (e) {
    return { status: 'ERR', body: String(e.cause?.code || e.name), ms: Date.now() - t };
  }
}
const pay = (id, amount) => call('POST', `${FEE}/students/${id}/payments`, { amount });
const fees = (id) => call('GET', `${FEE}/students/${id}/fees`);
const stats = async () => (await call('GET', `${BANK}/stats`)).body;
const fmt = (r) => `${r.status} ${JSON.stringify(r.body)} (${r.ms}ms)`;
const check = (ok, label) => console.log(`  ${ok ? '✅' : '❌'} ${label}`);

async function runPool(n, concurrency, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < n) { const k = i++; results[k] = await fn(k); }
  }));
  return results;
}
const tally = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});

async function s1() {
  console.log('\n=== Tình huống 1: ngân hàng tắt rồi bật lại ===');
  for (const bankUrl of [undefined, 'http://localhost:4999']) {
    console.log(`-- BANK_URL=${bankUrl || '(mặc định)'}`);
    const fee = await start(FEE_FILE, bankUrl ? { BANK_URL: bankUrl } : {});
    const r1 = await pay(1, 100000);
    console.log('  thanh toán khi ngân hàng tắt:', fmt(r1));
    await sleep(200);
    const f = await fees(1);
    console.log('  GET fees:', fmt(f), '| Fee Service còn sống:', fee.alive);
    check(r1.status === 503 && r1.body?.error && r1.ms < 1500, '503 + JSON error trong < 1,5s');
    check(fee.alive && f.status === 200 && f.ms < 300, 'Fee Service không sập, GET fees 200 nhanh');
    if (!bankUrl) {
      const bank = await start(BANK_FILE);
      const r2 = await pay(1, 100000);
      console.log('  thanh toán sau khi bật ngân hàng:', fmt(r2));
      check(r2.status === 201, '201 khi ngân hàng chạy lại, không khởi động lại Fee');
      await stop(bank);
    }
    await stop(fee);
  }
}

async function s2() {
  console.log('\n=== Tình huống 2: ngân hàng chậm (DELAY_MS=5000) ===');
  const bank = await start(BANK_FILE, { DELAY_MS: 5000 });
  const fee = await start(FEE_FILE, { RECONCILE_MS: 0 });
  const r = await pay(1, 100000);
  console.log('  1 thanh toán:', fmt(r));
  check(r.status === 504 && r.body?.status === 'PENDING', '504 + PENDING');
  check(r.ms <= 4500, `thời gian ≤ 4,5s (${r.ms}ms)`);
  const burst = Array.from({ length: 20 }, () => pay(1, 100000));
  await sleep(300);
  const f = await fees(1);
  const rs = await Promise.all(burst);
  console.log('  20 thanh toán đồng thời:', JSON.stringify(tally(rs)), '| chậm nhất', Math.max(...rs.map((x) => x.ms)), 'ms');
  console.log('  GET fees trong lúc chờ:', fmt(f));
  check(f.status === 200 && f.ms < 300, `GET fees < 300ms (${f.ms}ms)`);
  await stop(fee); await stop(bank);
}

async function s3() {
  console.log('\n=== Tình huống 3: duy trì kết nối (200 thanh toán, 10 đồng thời) ===');
  const bank = await start(BANK_FILE);
  const fee = await start(FEE_FILE);
  const t = Date.now();
  const rs = await runPool(200, 10, () => pay(1, 1000));
  const total = Date.now() - t;
  const st = await stats();
  console.log(`  kết quả: ${JSON.stringify(tally(rs))} | tổng ${total}ms | stats ${JSON.stringify(st)}`);
  check(rs.filter((x) => x.status === 201).length === 200, '200/200 thành công');
  check(st.connections <= 20, `kết nối TCP ≤ 20 (${st.connections})`);
  console.log('  nhàn rỗi 6 giây...');
  await sleep(6000);
  const after = [];
  for (let i = 0; i < 5; i++) after.push(await pay(1, 1000));
  console.log('  sau nhàn rỗi:', JSON.stringify(tally(after)), '| stats', JSON.stringify(await stats()));
  check(after.every((x) => x.status === 201), 'các yêu cầu sau nhàn rỗi vẫn thành công');
  await stop(fee); await stop(bank);
}

async function s4() {
  for (const [label, env] of [['(a) DROP_RATE=0.3', { DROP_RATE: 0.3 }], ['(b) FAIL_RATE=0.3', { FAIL_RATE: 0.3 }]]) {
    console.log(`\n=== Tình huống 4${label}: 60 thanh toán lần lượt ===`);
    const bank = await start(BANK_FILE, env);
    const fee = await start(FEE_FILE, { RECONCILE_MS: 0 });
    const before = (await fees(1)).body?.balance;
    const rs = [];
    for (let i = 0; i < 60; i++) rs.push(await pay(1, 1000));
    const st = await stats();
    const f = await fees(1);
    const paid = rs.filter((x) => x.status === 201).length;
    const bad = rs.filter((x) => x.status !== 201);
    console.log(`  kết quả: ${JSON.stringify(tally(rs))} | PAID=${paid} | stats ${JSON.stringify(st)} | chậm nhất ${Math.max(...rs.map((x) => x.ms))}ms`);
    if (bad.length) console.log('  ví dụ lỗi:', fmt(bad[0]));
    console.log(`  công nợ: ${before} -> ${f.body?.balance} (giảm ${before - f.body?.balance}, PAID×1000=${paid * 1000})`);
    check(st.duplicates === 0, 'duplicates = 0');
    check(paid >= 54, `≥ 54/60 thành công (${paid})`);
    if (label.startsWith('(a)')) check(bad.every((x) => x.status === 504 && x.body?.status === 'PENDING'), 'lệnh không thành công trả 504 + PENDING');
    else check(st.charges === paid, `số lần trừ tiền = số lệnh PAID (${st.charges} = ${paid})`);
    check(f.status === 200 && before - f.body.balance === paid * 1000, 'công nợ chỉ giảm đúng tiền các lệnh PAID');
    check(Math.max(...rs.map((x) => x.ms)) <= 4500, 'mỗi lệnh ≤ 4,5s');
    await stop(fee); await stop(bank);
  }
  console.log('\n=== Tình huống 4(c): vượt hạn mức 25.000.000đ ===');
  const bank = await start(BANK_FILE);
  const fee = await start(FEE_FILE);
  const r = await pay(1, 25_000_000);
  const st = await stats();
  console.log('  ', fmt(r), '| stats', JSON.stringify(st));
  check(r.status === 402, 'trả 402');
  check(st.requests === 1, `ngân hàng nhận đúng 1 yêu cầu (${st.requests})`);
  await stop(fee); await stop(bank);
}

(async () => {
  console.log(`##### Biến thể: ${variant} (${path.basename(FEE_FILE)}) #####`);
  const all = { 1: s1, 2: s2, 3: s3, 4: s4 };
  for (const k of only.length ? only : [1, 2, 3, 4]) {
    try { await all[k](); } catch (e) { console.log('  lỗi khi chạy:', e.message); }
    for (const p of [...procs]) await stop(p);
  }
})();
