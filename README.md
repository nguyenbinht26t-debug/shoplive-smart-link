# ShopLive AI Smart Link Gateway 2.6.9

Gateway nhận URL công khai/không DRM, dùng yt-dlp khi cần, sau đó FFmpeg chuẩn hóa thành H.264/AAC để Android phát và encode lại lên nền tảng Live.

## Endpoint

Health:

`GET /health`

Smart Link 2.6.9:

`GET /api/source-v2?key=<KEY>&container=fmp4&url=<URL_ENCODED>`

Endpoint `/api/source` vẫn giữ cho client cũ. App 2.6.9 chủ động dùng `/api/source-v2` để phát hiện ngay trường hợp Render chưa được cập nhật.

## Điểm mới 2.6.9

- fMP4 (`video/mp4`) là container mặc định được app 2.6.9 yêu cầu.
- HTTP 200 chỉ được gửi sau khi FFmpeg thực sự tạo media init hợp lệ.
- Lỗi yt-dlp/FFmpeg trả HTTP 502 JSON để Android hiển thị nguyên nhân thật.
- Response có `x-shoplive-gateway-version` và `x-shoplive-container`.

## Docker

```bash
docker build -t shoplive-smart-link .
docker run --rm -p 8787:8787 \
  -e GATEWAY_API_KEY=KHOA_CUA_BAN \
  shoplive-smart-link
```

Dockerfile cài FFmpeg và cập nhật yt-dlp khi build image.

## Cookies tùy chọn

Một số link YouTube/Facebook có thể yêu cầu đăng nhập/chống bot. Gateway hỗ trợ `YTDLP_COOKIES_B64`; không đặt cookie trong APK.

## An toàn

- Dùng HTTPS ở production.
- Đặt API key mạnh và giữ biến môi trường ở server.
- Chỉ phát nội dung bạn sở hữu hoặc có quyền sử dụng.
- Không hỗ trợ DRM/paywall/private content khi Gateway không có quyền truy cập.
