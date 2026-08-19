# ShopLive AI 2.8.4 — Online Worker Fixed 1 cho Render

Worker này là **service riêng**, không thay thế và không ghi đè Smart Link Gateway API v5 hiện tại (2.8.6 trở lên, gồm 2.8.7).

## Chức năng

- Tối đa 3 phiên FFmpeg Online độc lập.
- Mỗi phiên nhận một nguồn khác nhau và một RTMP/RTMPS Facebook khác nhau.
- Video trong điện thoại: app upload tạm bằng `PUT /api/uploads/{id}`.
- Link trực tiếp: worker đọc URL.
- Link YouTube/Facebook/TikTok/Vimeo/Instagram: worker gọi Smart Link Gateway v5 hiện tại rồi đẩy RTMPS.
- H.264/AAC phù hợp ưu tiên stream-copy; nguồn cần xoay/đổi codec transcode và giữ hình học nguồn, không ép 720p.
- HTTP input reconnect + read/write timeout 120 giây.
- Tối đa 6 lỗi reconnect **liên tiếp**; khi stream chạy lại thành công bộ đếm lỗi liên tiếp được reset.
- Loop kết thúc video bình thường không bị tính là lỗi reconnect.
- API không trả lại RTMP URL/Stream Key; error/status redact RTMP URL và Smart Link key.
- Upload được tự xóa khi session dừng hoặc thất bại.
- Nhận trạng thái `RUNNING` bằng progress máy đọc được của FFmpeg, kể cả khi H.264/AAC dùng stream-copy.
- Dừng FFmpeg có SIGKILL dự phòng thật sự nếu SIGTERM không kết thúc tiến trình.
- Chặn đúng tối đa 3 phiên kể cả khi nhiều yêu cầu tạo phiên đến đồng thời.
- Phiên STOPPED/FAILED được giữ mặc định 6 giờ để app đọc trạng thái rồi tự dọn khỏi RAM.

## Bản Fixed 1 đã sửa

- Sửa trường hợp RTMPS đang gửi nhưng app vẫn chỉ hiện `STARTING/ONLINE` vì FFmpeg stream-copy không in `frame=` theo kiểu log cũ.
- Progress được ghép theo từng dòng nên không mất dữ liệu khi stderr bị chia nhỏ thành nhiều chunk.
- Khi đã có dữ liệu media, trạng thái chuyển `RUNNING`, xóa lỗi cũ và reset số lỗi reconnect liên tiếp.
- Tránh xử lý hai lần cùng một lần FFmpeg lỗi/thoát.
- Hủy timer reconnect khi người dùng Stop và buộc dừng tiến trình treo sau 5 giây.
- API key chỉ nhận qua header `X-ShopLive-Key`, không nhận trên query URL để tránh lộ key trong log.

## Deploy Render

1. Tạo **Web Service mới** từ repo Worker. Không dùng service `shoplive-smart-link` đang chạy.
2. Runtime: Docker, dùng `Dockerfile` trong ZIP.
3. Environment tối thiểu:
   - `WORKER_API_KEY`: key mới, dài, riêng cho Worker.
   - `SMART_LINK_BASE_URL=https://shoplive-smart-link.onrender.com`
   - `SMART_LINK_KEY`: key hiện tại của Smart Link Gateway.
   - `MAX_SESSIONS=3`
   - `SESSION_RETENTION_MS=21600000` (tùy chọn, mặc định 6 giờ)
4. Deploy rồi mở `/healthz`.
5. Trong app → Cài đặt → LIVE ONLINE • WORKER RIÊNG → nhập URL + `WORKER_API_KEY` → KIỂM TRA.
6. App gửi key đúng thì `/healthz` trả `authOk=true`.

## API chính

- `GET /healthz`
- `PUT /api/uploads/{id}`
- `DELETE /api/uploads/{id}`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{id}`
- `POST /api/sessions/{id}/stop`

Mọi API `/api/*` yêu cầu header `X-ShopLive-Key` đúng với `WORKER_API_KEY`.

## Lưu ý vận hành

- Mặc định upload nằm ở `/tmp`, filesystem của service không nên được coi là lưu trữ lâu dài. Đây là file tạm của phiên Live và worker xóa khi Stop.
- Nếu instance restart/redeploy, FFmpeg session trong RAM sẽ mất; tạo lại session từ app.
- 3 phiên transcode 1080p đồng thời có thể cần instance mạnh. Nguồn H.264/AAC stream-copy nhẹ hơn nhiều.
