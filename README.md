# ShopLive AI Smart Link Gateway 2.8.1

Gateway nhận URL video công khai/không DRM, dùng yt-dlp để tách nguồn khi cần, sau đó FFmpeg chuẩn hóa thành H.264/AAC HTTP-FLV cho Android.

## Endpoint

- `GET /healthz` — kiểm tra phiên bản, Node, trạng thái cookie/proxy.
- `GET /health?key=<KEY>` — health chi tiết.
- `GET /api/source-v3?key=<KEY>&container=flv&url=<URL_ENCODED>` — Smart Link hiện tại.

## Điểm mới 2.8.1

- `YTDLP_PROXY` chỉ áp dụng cho YouTube; proxy YouTube hết hạn không còn làm hỏng link Facebook/TikTok.
- Có thể cấu hình `META_PROXY` riêng nếu Facebook/Instagram thực sự cần proxy.
- Nhận diện video đang live từ metadata yt-dlp và bám luồng HLS/DASH ở live edge.
- Không dùng `-re` lần hai cho nguồn live; tăng thời gian chờ và làm mới manifest khi luồng ngắt.
- Probe trả thêm `isLive` và `liveStatus` để ứng dụng biết đây là nguồn trực tiếp.

## Nền tảng 2.8.0

- Khôi phục proxy đồng nhất cho yt-dlp, FFprobe và FFmpeg để tránh URL CDN bị lệch IP/403.
- Chỉ báo luồng HTTP-FLV sẵn sàng sau khi đã nhận được gói hình video thực tế, không chỉ header.
- Tự bỏ URL media đã lưu khi FFmpeg lỗi để lần thử lại lấy URL ký mới.
- Tự nối lại các lỗi mạng tạm thời, HTTP 408/429/5xx trong lúc đọc nguồn.

## Nền tảng 2.7.9

- Docker dùng Node 22.
- Cài `yt-dlp[default,curl-cffi]` để có EJS challenge scripts và browser impersonation.
- yt-dlp bật rõ `--js-runtimes node`.
- Cookie riêng: `YOUTUBE_COOKIES_B64`, `FACEBOOK_COOKIES_B64`; `YTDLP_COOKIES_B64` là fallback chung.
- `YTDLP_PROXY` là tùy chọn khi YouTube chặn IP datacenter của Render.
- Lỗi trả mã rõ ràng như `YOUTUBE_AUTH_REQUIRED`, `YOUTUBE_IP_OR_SESSION_BLOCKED`, `META_AUTH_REQUIRED`.

## Docker

```bash
docker build -t shoplive-smart-link .
docker run --rm -p 8787:8787 \
  -e GATEWAY_API_KEY=KHOA_CUA_BAN \
  shoplive-smart-link
```

## Cookie

Cookie phải là file `cookies.txt` định dạng Netscape được Base64 rồi lưu trong Render Environment. Không commit cookie lên GitHub và không nhúng vào APK.

## An toàn

Chỉ phát nội dung bạn sở hữu hoặc có quyền phát lại. Gateway không vượt DRM/paywall.
