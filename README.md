# ShopLive AI Smart Link Gateway 2.8.4

Gateway nhận URL video công khai/không DRM, dùng yt-dlp để tách nguồn khi cần, sau đó FFmpeg chuẩn hóa thành H.264/AAC HTTP-FLV cho Android.

## Endpoint

- `GET /healthz` — kiểm tra phiên bản, Node, trạng thái cookie/proxy.
- `GET /health?key=<KEY>` — health chi tiết.
- `GET /api/source-v3?key=<KEY>&container=flv&url=<URL_ENCODED>` — Smart Link hiện tại.

## Điểm mới 2.8.4

- Tích hợp PO Token provider 1.3.1 cho YouTube Live/DASH ngay trong Docker.
- Tự ưu tiên client `mweb` khi provider sẵn sàng, giúp yt-dlp nhận lại các định dạng livestream bị YouTube ẩn khi thiếu GVS PO Token.
- PO generator, yt-dlp, FFprobe và FFmpeg dùng cùng `YTDLP_PROXY`, tránh token/URL ký bị lệch IP.
- `/healthz` trả thêm `youtubePoProvider` và `youtubePlayerClients`; sau deploy đúng phải thấy `youtubePoProvider: true` và phiên bản `2.8.4`.
- Phân biệt rõ livestream chưa bắt đầu (`YOUTUBE_LIVE_NOT_STARTED`) với lỗi cấp PO Token (`YOUTUBE_PO_TOKEN_FAILED`).
- Lần Docker build đầu sẽ lâu hơn trước vài phút vì phải biên dịch PO provider; các lần build có cache sẽ nhanh hơn.

## Nền tảng 2.8.3

- Sửa lỗi Android Media3 `ArrayIndexOutOfBoundsException: length=0; index=0` sau khi Gateway đã probe được video.
- Nhánh nhẹ vẫn copy trực tiếp hình H.264 1080p, nhưng luôn dựng lại âm thanh thành AAC-LC 44.1 kHz stereo 128 kbps.
- Không cần xuất lại cookie khi probe đã trả đúng kích thước và lỗi chỉ xuất hiện ở bước Media3 mở HTTP-FLV.

## Nền tảng 2.8.2

- Chọn nguồn tối đa 1080p ngay từ yt-dlp: ngang tối đa `1920x1080`, dọc tối đa `1080x1920`.
- Video 2K/4K được giới hạn về khung 1080p nhưng giữ nguyên tỷ lệ; không crop, không pad, không kéo méo.
- Video vốn thấp hơn 1080p giữ nguyên kích thước, không phóng lớn làm nhòe.
- Bỏ `-re` ở đầu vào, tăng hàng đợi lên 4096 và timeout mạng lên 30 giây để Gateway nạp buffer nhanh hơn.
- Ưu tiên H.264/AAC để remux trực tiếp sang HTTP-FLV, giảm tải mã hóa lại trên Render.

## Nền tảng 2.8.1

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
