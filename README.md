# Lab 3 — Thanh toán học phí gọi cổng ngân hàng

## Cấu trúc

| File | Vai trò |
|---|---|
| `src/bank.js` | Ngân hàng giả lập, cổng 4002: `POST /charges`, `GET /stats`, `Idempotency-Key`, `DELAY_MS` / `FAIL_RATE` / `DROP_RATE` |
| `src/fee-service.js` | Fee Service **đã sửa**, cổng 4001 |
| `src/bank-client.js` | HTTP client gọi ngân hàng: keep-alive, timeout, thử lại an toàn |
| `src/fee-service.naive.js` | Fee Service **chưa sửa** (bản "trước") để đo so sánh |
| `scripts/scenarios.js` | Tự chạy 4 tình huống và in số liệu kèm ✅/❌ |

## Chạy

```bash
npm install
node src/bank.js                                  # terminal 1
node src/fee-service.js                           # terminal 2
DELAY_MS=5000 node src/bank.js                    # ngân hàng chậm
DROP_RATE=0.3 node src/bank.js                    # trừ tiền xong rồi cắt kết nối
FAIL_RATE=0.3 node src/bank.js                    # lỗi 500 trước khi trừ tiền
BANK_URL=http://localhost:4999 node src/fee-service.js

# Đo tự động (tự bật/tắt service, cần cổng 4001/4002 đang trống)
node scripts/scenarios.js fixed          # bản đã sửa
node scripts/scenarios.js naive          # bản trước khi sửa
node scripts/scenarios.js fixed 3        # chỉ chạy tình huống 3
```

Gọi tay bằng curl hoặc Postman:

```bash
curl localhost:4001/students/1/fees
curl -X POST localhost:4001/students/1/payments -H 'Content-Type: application/json' -d '{"amount":100000}'
curl localhost:4001/payments/P1        # tra trạng thái một lệnh
curl localhost:4002/stats
```

Biến môi trường của Fee Service: `BANK_URL` (mặc định `http://localhost:4002`), `BANK_DEADLINE_MS` (mặc định 4000), `CONNECT_TIMEOUT_MS` (mặc định 1000), `RECONCILE_MS` (chu kỳ đối soát lệnh PENDING, mặc định 10000; 0 là tắt), `RECONCILE_DEADLINE_MS` (thời gian chờ tối đa khi đối soát, mặc định 15000 — dài hơn vì không có sinh viên đang chờ).

## Cách xử lý từng tình huống

**1 — Ngân hàng không kết nối được.** Mọi lỗi khi gọi ngân hàng đều được bắt, nên tiến trình không sập. Lỗi kết nối (`ECONNREFUSED`, DNS, connect timeout 1 giây) có nghĩa yêu cầu chắc chắn chưa tới ngân hàng, nên Fee Service trả ngay **503 FAILED**. Mỗi lần thanh toán đều kết nối lại, nên khi ngân hàng chạy lại thì thanh toán thành công mà không cần khởi động lại Fee Service. Địa chỉ ngân hàng lấy từ `BANK_URL`.

**2 — Ngân hàng chậm.** Toàn bộ quá trình gọi ngân hàng, kể cả các lần thử lại, có ngân sách **4 giây**. Hết thời gian thì Fee Service hủy yêu cầu và trả **504 PENDING**, vì không biết ngân hàng đã trừ tiền hay chưa. Node.js không bị chặn khi chờ I/O, nên `GET /fees` vẫn nhanh. Tiền của các lệnh PROCESSING/PENDING được giữ chỗ (`reserved`), để sinh viên không thanh toán vượt công nợ.

**3 — Duy trì kết nối.** Client dùng `http.Agent({ keepAlive: true, maxSockets: 20 })` để tái sử dụng kết nối TCP. Kết nối rảnh được đóng sau 4 giây, trước mốc 5 giây mà ngân hàng tự đóng. Nếu vẫn gặp trường hợp socket keep-alive vừa bị đóng (`ECONNRESET` với `reusedSocket`), client gửi lại ngay. Gửi lại an toàn vì có Idempotency-Key.

**4 — Đứt giữa chừng, lỗi tạm thời, bị từ chối.** Mỗi lệnh có `Idempotency-Key` cố định. Key này cũng là reference, dạng `<mã-instance>-P<n>`, để không trùng với lần chạy trước.

| Bên ngân hàng | Fee Service xử lý | Kết quả nếu hết lượt thử |
|---|---|---|
| 2xx | PAID, giảm công nợ | — |
| 4xx (400, 402…) | **Không thử lại**, giữ mã của ngân hàng | FAILED |
| 5xx | Thử lại với cùng key, backoff có jitter (tối đa 5 lần, trong 4 giây) | 503 FAILED (chắc chắn chưa trừ) |
| Đứt kết nối khi đang chờ trả lời | Thử lại với cùng key; nếu đã trừ thì ngân hàng trả lại giao dịch cũ | 504 PENDING |
| Không kết nối được | Không thử lại | 503 FAILED (hoặc 504 nếu một lần thử trước có thể đã trừ) |
| Hết thời gian | Không thử lại | 504 PENDING |

Một job đối soát chạy nền gửi lại các lệnh PENDING với cùng key. Lệnh nào ngân hàng đã trừ tiền sẽ chuyển sang PAID. Lệnh không bao giờ bị trừ tiền hai lần.

## Số liệu trước / sau khi sửa (đo bằng `scripts/scenarios.js`)

| Tình huống | Trước (naive) | Sau (fixed) |
|---|---|---|
| 1. Ngân hàng tắt | Lỗi socket (36ms), **Fee Service sập**, GET fees lỗi kết nối, cần khởi động lại | **503** FAILED + JSON trong 35ms; GET fees 200 (2ms); ngân hàng bật lại → **201** (10ms); `BANK_URL=:4999` → 503 (13ms) |
| 2. DELAY_MS=5000 | 201 sau **5027ms**; 20 lệnh đồng thời, chậm nhất 5018ms; GET fees 2ms | **504 PENDING** sau **4013ms**; 20 lệnh → 20×504, chậm nhất 4013ms; GET fees **2ms** |
| 3. 200 lệnh, 10 đồng thời | 200/200, 119ms, **201 kết nối TCP** | 200/200, 104ms, **11 kết nối** (gồm 1 kết nối của lệnh gọi `/stats`); sau 6 giây nhàn rỗi 5/5 thành công |
| 4a. DROP_RATE=0.3 | Lần đứt đầu tiên làm **sập Fee Service**: 4/60 thành công | **60/60 PAID**, 79 yêu cầu, charges=60, **duplicates=0**, công nợ giảm đúng 60.000đ, chậm nhất 16ms |
| 4b. FAIL_RATE=0.3 | **42/60** (18 lỗi 500 trả thẳng cho sinh viên) | **60/60 PAID**, 80 yêu cầu, charges=60, duplicates=0, chậm nhất 945ms |
| 4c. 25.000.000đ | 402, ngân hàng nhận 1 yêu cầu | **402**, ngân hàng nhận **đúng 1** yêu cầu (không thử lại) |

> Số liệu 4a và 4b thay đổi giữa các lần chạy vì lỗi xảy ra ngẫu nhiên. Với 5 lần thử, xác suất một lệnh thất bại cả 5 lần chỉ khoảng 0,3⁵ ≈ 0,24%.

**Bài học chính:** thử lại chỉ an toàn khi có **Idempotency-Key**. Nếu bản naive tự gửi lại lệnh sau khi đứt kết nối mà không có key, thì `duplicates` sẽ lớn hơn 0, tức sinh viên bị trừ tiền hai lần.
