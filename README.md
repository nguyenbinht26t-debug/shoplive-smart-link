# ShopLive AI Smart Link Server

Máy chủ này nhận link chia sẻ **công khai, không DRM** từ YouTube/Facebook/TikTok/Vimeo/Instagram (hoặc link media trực tiếp), sau đó chuẩn hóa thành MPEG-TS H.264/AAC để app Android đưa vào encoder livestream. Chỉ sử dụng video bạn sở hữu hoặc có quyền phát lại.

## Cách chạy bằng Docker
```bash
docker build -t shoplive-smart-link .
docker run --rm -p 8787:8787 -e GATEWAY_API_KEY=KHOA_CUA_BAN shoplive-smart-link
```

Kiểm tra:
`GET /health?key=KHOA_CUA_BAN`

Nguồn video:
`GET /api/source?key=KHOA_CUA_BAN&url=<LINK_DA_MA_HOA_URL>`

## Dùng trong APK
Không cần hiện Gateway trong giao diện. Trước khi build, thêm vào `local.properties`:
```properties
SHOPLIVE_SMART_LINK_URL=https://link-api.tenmiencuaban.vn
SHOPLIVE_SMART_LINK_KEY=KHOA_CUA_BAN
```

Server production nên chạy HTTPS. Không mở server public nếu chưa đặt API key mạnh, rate limit/firewall ở reverse proxy.

## Giới hạn
- Không hỗ trợ DRM, paywall, nội dung riêng tư mà server không được phép truy cập.
- Nền tảng có thể thay đổi cơ chế phát video; hãy cập nhật `yt-dlp` định kỳ.
- Một số nội dung thuộc tài khoản của chính bạn có thể cần cookies do bạn tự cung cấp qua `YTDLP_COOKIES_FILE`.
