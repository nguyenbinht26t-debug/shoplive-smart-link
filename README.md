# ShopLive AI Smart Link Gateway 2.7.7

Gateway nhận URL video công khai/không DRM, dùng yt-dlp để tách nguồn khi cần, sau đó FFmpeg chuẩn hóa thành H.264/AAC HTTP-FLV cho Android.

## Endpoint

- `GET /healthz` — kiểm tra phiên bản, Node, trạng thái cookie/proxy.
- `GET /health?key=<KEY>` — health chi tiết.
- `GET /api/source-v3?key=<KEY>&container=flv&url=<URL_ENCODED>` — Smart Link hiện tại.

## Điểm mới 2.7.7

- FFmpeg dùng cùng `YTDLP_PROXY` cho mọi URL media do yt-dlp tách ra.
- Sửa lỗi Googlevideo trả `403 Forbidden` khi URL được ký theo IP proxy nhưng FFmpeg trước đây lại tải bằng IP Render.
- Luồng HTTP-FLV vẫn được relay và chuyển mã trực tiếp qua Gateway; app không nhận URL Googlevideo bị khóa IP.

## Nền tảng 2.7.6

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
