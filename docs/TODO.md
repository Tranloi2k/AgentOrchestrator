# Việc cần làm cho AgentOrchestrator

## Bối cảnh

Ngày 28/10/2026 mình review lại dự án. Mục tiêu dài hạn là biến AgentOrchestrator thành hệ thống Supervisor–Subagent có UI, dùng được agent của nhiều nhà cung cấp cho 3 việc: code, nghiên cứu và làm content.

Phần lõi đã khá tốt: agent chạy bằng CLI đã đăng nhập nên không cần API key, Claude và Codex gọi được lẫn nhau qua `ask_agent`, workflow dạng graph chạy được song song, có resume và cô lập nhánh bằng git worktree. Còn 2 lỗi phải sửa trước khi dùng thật, vài việc nên dọn dẹp, và một số tính năng còn thiếu so với mục tiêu.

Thứ tự bên dưới cũng là thứ tự nên làm.

## Tóm tắt

| # | Việc | Mức độ |
|---|------|--------|
| 1 | Chặn truy cập server từ bên ngoài (CORS, host, token) | Nghiêm trọng |
| 2 | Sửa lỗi `node_modules` bị commit trên macOS/Linux | Lỗi |
| 3 | Cho CI chạy test | Nên làm |
| 4 | Tách `orchestrator.js` | Nên làm |
| 5 | Thêm tool `spawn_agent` | Tính năng |
| 6 | Thêm provider Gemini CLI | Tính năng |
| 7 | Workflow mẫu cho nghiên cứu và content | Tính năng |

---

## 1. Chặn truy cập server từ bên ngoài

- [x] Bind server vào `127.0.0.1` thay vì mọi interface
- [x] Giới hạn CORS, chỉ cho origin của UI (`http://localhost:5173`)
- [x] Kiểm tra header `Origin` khi mở kết nối WebSocket
- [x] Bảo vệ `/api/internal/ask-agent` bằng token ngẫu nhiên sinh lúc server khởi động, truyền cho `mcp-bridge` qua biến môi trường
- [x] (Tùy chọn) Giới hạn `/api/browse-dirs` và `cwd` trong một danh sách thư mục gốc cho phép

**Vấn đề:** `server/index.js` đang gọi `app.use(cors())` không giới hạn origin, và `server.listen(PORT)` không chỉ định host. Khi test, preflight gửi từ `https://evil.example` vẫn nhận về `Access-Control-Allow-Origin: *`.

**Hậu quả:** khi server đang chạy, trang web bất kỳ đang mở trong trình duyệt, hoặc máy khác trong cùng mạng LAN, đều gọi được `POST /api/run` với `cwd` tùy ý. Nếu agent ở chế độ `danger-full-access` thì gần như là chạy code từ xa trên máy. Ngoài ra còn đọc được cây thư mục và log các lần chạy.

**Kiểm tra sau khi sửa:** gửi lại preflight từ origin lạ thì không còn header `Access-Control-Allow-Origin`, và từ máy khác trong mạng LAN không gọi được API.

## 2. `node_modules` bị commit vào nhánh merge trên macOS/Linux

- [ ] Làm cho các đường dẫn được link vào worktree không bị `git add -A` nhặt vào
- [ ] Chạy `node --test` trong `server/`, đảm bảo pass 15/15

**Vấn đề:** test `gitignored dependencies are reachable from the worktree` bị fail trên Linux, kết quả có `node_modules` thay vì chỉ `tracked.txt`.

**Nguyên nhân:** `workspace.js` link `node_modules` vào worktree. Trên Windows link đó là junction nên git coi là thư mục. Trên macOS/Linux nó là symlink, mà git coi symlink là file. Dòng `node_modules/` trong `.gitignore` có dấu `/` ở cuối nên chỉ khớp với thư mục, không khớp với symlink. Trên Windows không thấy lỗi này.

**Hướng sửa:** ghi các đường dẫn đã link vào `.git/info/exclude` của worktree (không có dấu `/` cuối), hoặc loại chúng ra trước bước `git add`.

## 3. Cho CI chạy test

- [ ] Thêm bước `node --test` (chạy trong `server/`) vào `.github/workflows/ci.yml`

**Lý do:** hiện CI chỉ build client, chạy `node --check` và smoke test `/api/meta`. CI chạy trên Ubuntu nên nếu có bước test thì đã bắt được lỗi số 2.

## 4. Tách `orchestrator.js`

- [x] Tách file 2051 dòng (86KB) thành các module nhỏ, gợi ý:
  - agent / skill / plugin registry (CRUD + lưu config)
  - CLI runners (claude, codex, sau này thêm gemini)
  - graph executor (chạy workflow, router, merge, resume)
  - run store (lịch sử run, ghi `runs.json`)

**Lý do:** dễ đọc, dễ test riêng từng phần, và việc 5, 6 sẽ dễ làm hơn nhiều.

## 5. Tool `spawn_agent`

- [x] Thêm tool `spawn_agent` vào `mcp-bridge.js`, đặt cạnh `ask_agent`
- [x] Supervisor tự chọn provider, model, prompt và tool, nhưng chỉ trong whitelist
- [x] Dùng lại `MAX_CALL_DEPTH`, thêm giới hạn số agent mỗi run và ngân sách token
- [x] Hiển thị agent được spawn trên UI (Run tab)

**Lý do:** hiện supervisor chỉ tự tạo subagent được qua tool `Task` của Claude, và subagent tạo ra cũng chỉ là Claude. Muốn supervisor tự tạo subagent của nhà cung cấp khác thì cần tool này.

## 6. Provider Gemini CLI

- [x] Thêm runner cho Gemini CLI, kiểm tra CLI có cài chưa lúc khởi động giống claude và codex
- [x] Nối Gemini vào `mcp-bridge` để gọi được `ask_agent` / `spawn_agent`

## 7. Workflow mẫu cho nghiên cứu và content

- [ ] Workflow nghiên cứu: supervisor tách câu hỏi, các agent tìm hiểu song song, tổng hợp lại
- [ ] Workflow content: nghiên cứu, viết nháp, review, chỉnh sửa
- [ ] (Tùy chọn) Kiểu council: nhiều model cùng viết một nội dung, supervisor chọn bản tốt nhất
