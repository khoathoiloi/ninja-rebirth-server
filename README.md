# Ninja Rebirth - Private Game Server & GM Dashboard

Dự án máy chủ riêng (Private Server) và Bảng Điều Khiển GM cho game **Ninja Rebirth / Hỏa Ảnh Mobile** (Cocos2d-JS client).

---

## 📌 Tính Năng Đã Hoàn Thiện

1. **HTTP Gateway (Cổng 80 & 8080):**
   - Hỗ trợ tải `clientConfigData.json` và phân giải cấu hình package SDK.
   - Hotfix Asset Manifest: Bypass kiểm tra phiên bản với `version.manifest` và `project.manifest` (v1.0.0.3).
   - SDK Auth API: Xác thực tài khoản (`/auth?api=check_user`).
   - Server List API: Phân phối danh sách máy chủ theo chuẩn Cocos `{ servers: [...] }`.
   - Notifications API: Tự động đóng màn hình loading và kích hoạt nút **Vào Game**.

2. **WebSocket Game RPC (Cổng 9001):**
   - Đóng gói dữ liệu chuẩn Cocos Netty Client với **4-byte Big-Endian Length Framing Header**.
   - Hỗ trợ gói tin lệnh đăng nhập (`SVRCMD.Login`), đồng bộ thời gian (`SVRCMD.Time`), và xử lý nhân vật.

3. **GM Web Dashboard (Giao diện Quản Trị):**
   - Truy cập tại: `http://localhost:8080/admin` (hoặc `http://localhost/admin`).
   - Quản lý trạng thái máy chủ (Bật / Tắt / Thêm server mới).
   - Quản lý tài khoản người chơi: Thêm người dùng, chỉnh sửa Vàng, Kim Cương, Cấp độ, Cấp VIP tức thì.

---

## 💻 Hướng Dẫn Cài Đặt & Chạy Ở Máy Mới / Máy Ở Nhà

### 1. Chuẩn bị môi trường
- Cài đặt **Node.js** (Khuyên dùng v18 hoặc v20+): [https://nodejs.org/](https://nodejs.org/)
- Trình giả lập Android: **LDPlayer 9** (hoặc NoxPlayer, MuMuPlayer, Nox, thiết bị Android đã root).

### 2. Cài đặt Server
Mở Terminal hoặc Command Prompt tại thư mục dự án và chạy:
```bash
npm install
```

### 3. Cấu hình IP cho máy mới
1. Mở CMD trên máy tính và gõ lệnh:
   ```cmd
   ipconfig
   ```
   Tìm dòng `IPv4 Address`, ví dụ: `192.168.1.100` (đây là IP mạng LAN của máy bạn).

2. Mở file `hosts.txt`, thay thế IP `192.168.0.152` thành IP máy bạn:
   ```text
   127.0.0.1        localhost
   <IP_CỦA_BẠN>     hotfix.indonesia.manliu.top
   <IP_CỦA_BẠN>     hotfix.testindonesia.manliu.top
   <IP_CỦA_BẠN>     auth.indonesia.manliu.top
   <IP_CỦA_BẠN>     auth.testindonesia.manliu.top
   ```

3. Mở file `data/db.json`, thay đổi `serverip` của server thành `<IP_CỦA_BẠN>`:
   ```json
   "serverip": "<IP_CỦA_BẠN>"
   ```

### 4. Khởi chạy Server
- Chạy trực tiếp file `start_server.bat` (nhấp đúp chuột), hoặc chạy bằng lệnh:
  ```bash
  node server.js
  ```
- Mở trình duyệt vào link quản trị GM:
  ```
  http://localhost:8080/admin
  ```

### 5. Thiết lập trên Giả lập LDPlayer 9
1. Tải ứng dụng **Virtual Hosts** (hoặc cài file apk Virtual Hosts).
2. Mở app Virtual Hosts trên LDPlayer, bấm **Select Hosts File** và chọn file `hosts.txt`.
3. Bật công tắc của Virtual Hosts lên màu xanh lá (ON).
4. Mở game Ninja Rebirth và trải nghiệm!
